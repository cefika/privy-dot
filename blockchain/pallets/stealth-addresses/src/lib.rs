//! # Pallet Stealth Addresses
//!
//! Implementation of ECPDKSAP (Elliptic Curve Pairing Dual Key Stealth Address Protocol)
//! at the Substrate runtime level.
//!
//! ## What this pallet does
//!
//! - **Meta-address registry** — users register (spending_pubkey, viewing_pubkey) once;
//!   all parachains in the Polkadot network can read them via XCM.
//! - **Announcement index** — the sender calls `announce` after a transaction; the pallet
//!   automatically indexes the announcement by view tag, so the recipient scans only ~1/65536 of all announcements.
//! - **Gas sponsorship** — a stealth address has no native token; sponsors deposit DOT into a pool,
//!   and the pallet covers the fee on withdrawal, taking a commission from the withdrawn funds.
//! - **Viewing key delegation** — the recipient can delegate the viewing key to an auditor/inspector
//!   for a time-limited period without revealing the spending key.
//!
//! ## Integration with the EVM contract
//!
//! The existing ECPDKSAP PVM contract (`contracts/rust/`) emits `Announcement` events.
//! The precompile (future phase) will bridge EVM calls to these extrinsics.
//! For now, extrinsics are called directly via Substrate transactions or XCM.

#![cfg_attr(not(feature = "std"), no_std)]

extern crate alloc;

pub use pallet::*;

#[cfg(test)]
mod mock;

#[cfg(test)]
mod tests;

pub mod weights;

#[frame::pallet]
pub mod pallet {
    use crate::weights::WeightInfo;
    use alloc::{vec, vec::Vec};
    use frame::prelude::*;
    use frame::traits::fungible::{Inspect as FungibleInspect, Mutate as FungibleMutate, MutateHold};
    use frame::traits::fungibles::{self, Inspect as FungiblesInspect, Mutate as FungiblesMutate};
    use frame::traits::tokens::{Fortitude, Precision, Preservation};
    use polkadot_sdk::staging_xcm::prelude::*;

    /// Balance type for the native token, derived from the `NativeBalance` associated type.
    pub type BalanceOf<T> = <<T as Config>::NativeBalance as FungibleInspect<
        <T as frame_system::Config>::AccountId,
    >>::Balance;

    /// Balance type for pallet-assets tokens, derived from the `Assets` associated type.
    pub(crate) type AssetBalanceOf<T> = <<T as Config>::Assets as fungibles::Inspect<
        <T as frame_system::Config>::AccountId,
    >>::Balance;

    // =========================================================================
    // TYPES AND STRUCTURES
    // =========================================================================

    /// Stealth meta-address — the public part of a user's key pair.
    ///
    /// Protocol: ECPDKSAP Protocol 3
    /// - `spending_pubkey` : K = k × G  on Secp256k1 (33 bytes, compressed)
    /// - `viewing_pubkey`  : V = v × G₁ on BN254 G1   (64 bytes, uncompressed)
    /// - `scheme_id`       : scheme identifier (ECPDKSAP uses 2901)
    #[derive(Clone, Encode, Decode, TypeInfo, MaxEncodedLen, RuntimeDebug, PartialEq)]
    pub struct StealthMetaAddress {
        /// Spending public key — Secp256k1, 33 bytes compressed
        pub spending_pubkey: [u8; 33],
        /// Viewing public key — BN254 G1, 64 bytes uncompressed (x ++ y)
        pub viewing_pubkey: [u8; 64],
        /// Scheme identifier (e.g. 2901 for ECPDKSAP)
        pub scheme_id: u32,
    }

    /// Transaction announcement — data that the sender writes on chain.
    ///
    /// The recipient scans `ViewTagIndex` for their view tag, then for each hit
    /// performs a full cryptographic check using `ephemeral_pubkey` and their `viewing_key`.
    #[derive(Clone, Encode, Decode, TypeInfo, MaxEncodedLen, RuntimeDebug)]
    pub struct Announcement<AccountId> {
        /// Ephemeral public key R = r × G₁ — BN254 G1, 64 bytes
        pub ephemeral_pubkey: [u8; 64],
        /// View tag — first 2 bytes of hash(r × V)
        /// Reduces false positives to ~1/65536 compared to full scanning.
        pub view_tag: [u8; 2],
        /// Stealth address to which funds were sent
        pub stealth_address: AccountId,
        /// Optional metadata (token type, amount, etc.) — 32 bytes
        pub metadata: [u8; 32],
    }

    /// Viewing key delegation — the compliance layer of the protocol.
    ///
    /// A user can delegate the viewing key to an inspector/accountant for a
    /// specific time period. The delegate can VIEW transactions but CANNOT spend.
    /// The viewing key is encrypted with the delegate's public key before being written on chain.
    #[derive(Clone, Encode, Decode, TypeInfo, MaxEncodedLen, RuntimeDebug)]
    pub struct ViewingKeyDelegation<AccountId, BlockNumber> {
        /// Who the access is delegated to
        pub delegate: AccountId,
        /// From which block it is valid
        pub valid_from: BlockNumber,
        /// Until which block it is valid (None = no expiry)
        pub valid_until: Option<BlockNumber>,
        /// Viewing key encrypted with the delegate's public key (ECIES or similar)
        pub encrypted_viewing_key: [u8; 64],
    }

    // =========================================================================
    // HOLD REASON — reason for locking sponsor funds
    // =========================================================================

    /// Reason why the sponsor's funds are locked in the Balances pallet.
    ///
    /// The runtime automatically combines `HoldReason` enums from all pallets into
    /// `RuntimeHoldReason` — the same mechanism used by `pallet_staking`,
    /// `pallet_democracy`, etc.
    #[pallet::composite_enum]
    pub enum HoldReason {
        /// Funds locked as a deposit in the gas sponsor pool.
        SponsorPool,
    }

    // =========================================================================
    // PALLET CONFIGURATION
    // =========================================================================

    #[pallet::config]
    pub trait Config: frame_system::Config<RuntimeEvent: From<Event<Self>>> {

        /// Maximum number of announcements per view tag (globally across the entire chain).
        #[pallet::constant]
        type MaxAnnouncementsPerViewTag: Get<u32>;

        /// Maximum number of viewing key delegations per user.
        #[pallet::constant]
        type MaxDelegationsPerUser: Get<u32>;

        /// Minimum deposit for gas sponsorship (in planck).
        #[pallet::constant]
        type MinSponsorDeposit: Get<u128>;

        /// Fee released to the sponsor and forwarded to the relayer on each
        /// withdrawal from a stealth address (in planck).
        #[pallet::constant]
        type WithdrawalFee: Get<u128>;

        /// Interface to the native token — for locking and transferring funds.
        ///
        /// In the runtime this is set to `Balances` (the pallet_balances instance).
        /// Must support the `hold`/`release` mechanism for the gas sponsor pool.
        type NativeBalance: FungibleInspect<Self::AccountId>
            + FungibleMutate<Self::AccountId>
            + MutateHold<Self::AccountId, Reason = Self::RuntimeHoldReason>;

        /// Runtime-level hold reason enum that includes our `HoldReason`.
        type RuntimeHoldReason: From<HoldReason>;

        /// Asset identifier in pallet-assets (in the runtime this is `u32`).
        /// `Into<u64>` is required for XCM GeneralIndex encoding.
        type AssetId: Member + Parameter + MaxEncodedLen + Clone + Into<u64>;

        /// Index of the Assets pallet in construct_runtime! (e.g. 52).
        /// Used to construct the XCM asset location.
        #[pallet::constant]
        type AssetsPalletIndex: Get<u8>;

        /// Interface to pallet-assets — for transferring ERC20-compatible tokens
        /// (e.g. USDC, rSDC) from a stealth address.
        ///
        /// Gas sponsorship always uses the native token (PAS/DOT);
        /// this type covers only the transfer of the asset itself.
        type Assets: fungibles::Inspect<Self::AccountId, AssetId = Self::AssetId>
            + fungibles::Mutate<Self::AccountId>;

        /// XCM sender — for sending cross-chain messages.
        type XcmSender: SendXcm;

        /// RuntimeCall type — required for encoding Transact XCM calls.
        type RuntimeCall: codec::Encode + From<Call<Self>>;

        /// Operation weights.
        type WeightInfo: WeightInfo;
    }

    // =========================================================================
    // STORAGE
    // =========================================================================

    #[pallet::pallet]
    pub struct Pallet<T>(_);

    /// Stealth meta-address registry.
    ///
    /// AccountId → StealthMetaAddress
    ///
    /// Advantage over an EVM registry: available to all parachains via XCM,
    /// no EVM overhead, directly readable from the runtime API.
    #[pallet::storage]
    pub type StealthMetaAddressRegistry<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        StealthMetaAddress,
        OptionQuery,
    >;

    /// Announcements — central list, indexed by nonce.
    ///
    /// The recipient reads `ViewTagIndex` for filtering, then loads the
    /// specific announcement from this storage on demand.
    #[pallet::storage]
    pub type Announcements<T: Config> = StorageMap<
        _,
        Twox64Concat,
        u64,
        Announcement<T::AccountId>,
        OptionQuery,
    >;

    /// Secondary index: view_tag → list of nonces of announcements with that tag.
    ///
    /// This is the key advantage over the smart contract approach:
    /// the runtime automatically indexes on write; the recipient does not scan all announcements.
    #[pallet::storage]
    pub type ViewTagIndex<T: Config> = StorageMap<
        _,
        Twox64Concat,
        [u8; 2],
        BoundedVec<u64, T::MaxAnnouncementsPerViewTag>,
        ValueQuery,
    >;

    /// Global monotonically increasing nonce for announcements.
    #[pallet::storage]
    pub type AnnouncementNonce<T: Config> = StorageValue<_, u64, ValueQuery>;

    /// Gas sponsorship pool.
    ///
    /// Sponsor → deposited amount in planck.
    /// Used to pay fees on withdrawal from a stealth address
    /// (which has no native token of its own).
    #[pallet::storage]
    pub type GasSponsorPool<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        u128,
        ValueQuery,
    >;

    /// Viewing key delegations by owner.
    #[pallet::storage]
    pub type ViewingKeyDelegations<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        BoundedVec<
            ViewingKeyDelegation<T::AccountId, BlockNumberFor<T>>,
            T::MaxDelegationsPerUser,
        >,
        ValueQuery,
    >;

    // =========================================================================
    // EVENTS
    // =========================================================================

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// A user registered a stealth meta-address.
        MetaAddressRegistered {
            who: T::AccountId,
            scheme_id: u32,
        },
        /// A user updated their stealth meta-address.
        MetaAddressUpdated {
            who: T::AccountId,
            scheme_id: u32,
        },
        /// A new stealth transaction was announced.
        /// The recipient's wallet scans this event filtering by view tag.
        Announced {
            nonce: u64,
            ephemeral_pubkey: [u8; 64],
            view_tag: [u8; 2],
            stealth_address: T::AccountId,
        },
        /// A sponsor deposited funds into the gas pool.
        GasSponsorDeposited {
            sponsor: T::AccountId,
            amount: u128,
        },
        /// Viewing key delegated to another account.
        ViewingKeyDelegated {
            owner: T::AccountId,
            delegate: T::AccountId,
            valid_until: Option<BlockNumberFor<T>>,
        },
        /// Cross-chain stealth payment of a pallet-assets token (USDC, etc.) sent.
        StealthAssetXcmSent {
            dest_para_id: u32,
            asset_id: T::AssetId,
            stealth_address: [u8; 32],
            amount: u128,
            announcement_nonce: u64,
        },
        /// Cross-chain stealth payment of the native token sent.
        StealthXcmSent {
            dest_para_id: u32,
            stealth_address: [u8; 32],
            amount: u128,
            announcement_nonce: u64,
        },
        /// Funds withdrawn from a stealth address with gas sponsorship.
        ///
        /// The relayer paid the Substrate tx fee; the sponsor refunded them
        /// `sponsor_fee` from their pool; the destination receives the full stealth balance.
        /// `asset_id = None` means the native token (PAS/DOT);
        /// `asset_id = Some(id)` means a pallet-assets token (rSDC, USDC...).
        StealthWithdrawal {
            stealth_address: T::AccountId,
            destination: T::AccountId,
            relayer: T::AccountId,
            sponsor: T::AccountId,
            sponsor_fee: u128,
            asset_id: Option<T::AssetId>,
        },
    }

    // =========================================================================
    // ERRORS
    // =========================================================================

    #[pallet::error]
    pub enum Error<T> {
        /// Meta-address not found for the given account.
        MetaAddressNotFound,
        /// View tag index is full for the given tag.
        ViewTagIndexFull,
        /// Insufficient funds in the gas sponsor pool.
        InsufficientSponsorFunds,
        /// Maximum number of delegations reached for this user.
        TooManyDelegations,
        /// User is trying to delegate to themselves.
        CannotDelegateToSelf,
        /// Deposit is below the minimum threshold.
        DepositBelowMinimum,
        /// XCM message could not be sent.
        XcmSendFailed,
        /// Amount must be greater than zero.
        ZeroAmount,
        /// ECDSA proof of ownership of the stealth address is invalid.
        ///
        /// Can be: bad signature, recovery failure, or the recovered address
        /// does not match the provided stealth address.
        InvalidProof,
    }

    // =========================================================================
    // EXTRINSICS
    // =========================================================================

    #[pallet::call]
    impl<T: Config> Pallet<T> {
        /// Register or update a stealth meta-address.
        ///
        /// The recipient calls this once to publish (spending_pubkey, viewing_pubkey).
        /// A subsequent call updates the existing meta-address (for key rotation).
        ///
        /// Flow: user generates k, v → K = k×G (Secp256k1), V = v×G₁ (BN254) → calls this function.
        #[pallet::call_index(0)]
        #[pallet::weight(T::WeightInfo::register_stealth_meta_address())]
        pub fn register_stealth_meta_address(
            origin: OriginFor<T>,
            spending_pubkey: [u8; 33],
            viewing_pubkey: [u8; 64],
            scheme_id: u32,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;

            let meta_address = StealthMetaAddress { spending_pubkey, viewing_pubkey, scheme_id };
            let exists = StealthMetaAddressRegistry::<T>::contains_key(&who);

            StealthMetaAddressRegistry::<T>::insert(&who, meta_address);

            if exists {
                Self::deposit_event(Event::MetaAddressUpdated { who, scheme_id });
            } else {
                Self::deposit_event(Event::MetaAddressRegistered { who, scheme_id });
            }

            Ok(())
        }

        /// Announce a stealth transaction.
        ///
        /// The sender calls this after sending funds to the stealth address.
        /// The runtime automatically indexes the announcement by view tag.
        ///
        /// Protocol flow (Protocol 3):
        /// 1. Sender generates ephemeral key r → R = r × G₁
        /// 2. Computes b = hash(r × V), stealth_addr = keccak(K + b×G)[12:]
        /// 3. Computes view_tag = hash(r × V)[0..2]
        /// 4. Sends funds to stealth_addr
        /// 5. Calls this function with (R, view_tag, stealth_addr)
        #[pallet::call_index(1)]
        #[pallet::weight(T::WeightInfo::announce())]
        pub fn announce(
            origin: OriginFor<T>,
            ephemeral_pubkey: [u8; 64],
            view_tag: [u8; 2],
            stealth_address: T::AccountId,
            metadata: [u8; 32],
        ) -> DispatchResult {
            let _who = ensure_signed(origin)?;

            let nonce = AnnouncementNonce::<T>::get();

            Announcements::<T>::insert(nonce, Announcement {
                ephemeral_pubkey,
                view_tag,
                stealth_address: stealth_address.clone(),
                metadata,
            });

            // Automatically index by view tag — the recipient filters without scanning everything
            ViewTagIndex::<T>::try_mutate(view_tag, |nonces| {
                nonces.try_push(nonce).map_err(|_| Error::<T>::ViewTagIndexFull)
            })?;

            AnnouncementNonce::<T>::put(nonce.saturating_add(1));

            Self::deposit_event(Event::Announced {
                nonce,
                ephemeral_pubkey,
                view_tag,
                stealth_address,
            });

            Ok(())
        }

        /// Deposit funds into the gas sponsor pool.
        ///
        /// Funds **remain in the sponsor's account** but are locked via
        /// the Balances `hold` mechanism (`HoldReason::SponsorPool`). This means:
        /// - The sponsor can see the locked funds in their account
        /// - Funds cannot be spent while they are locked
        /// - The pallet releases them atomically on each `withdraw_from_stealth` call
        ///
        /// Advantage over transferring to a dedicated pool account: no `PalletId`,
        /// no `ExistentialDeposit` issues, clear provenance of funds.
        #[pallet::call_index(2)]
        #[pallet::weight(T::WeightInfo::sponsor_gas())]
        pub fn sponsor_gas(
            origin: OriginFor<T>,
            amount: u128,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;

            ensure!(amount >= T::MinSponsorDeposit::get(), Error::<T>::DepositBelowMinimum);

            // Convert to BalanceOf<T> — saturated_into is safe because
            // BalanceOf<T> is always AtLeast32BitUnsigned and amount is u128.
            let amount_balance: BalanceOf<T> = amount.saturated_into();

            // Lock funds in the sponsor's account.
            // If there are not enough free funds, Balances returns an error.
            let hold_reason: T::RuntimeHoldReason = HoldReason::SponsorPool.into();
            T::NativeBalance::hold(&hold_reason, &who, amount_balance)
                .map_err(|_| Error::<T>::InsufficientSponsorFunds)?;

            // Update the pool record (u128 for easier use in logic)
            GasSponsorPool::<T>::mutate(&who, |deposit| {
                *deposit = deposit.saturating_add(amount);
            });

            Self::deposit_event(Event::GasSponsorDeposited { sponsor: who, amount });
            Ok(())
        }

        /// Delegate the viewing key to another account for selective disclosure.
        ///
        /// A user can give a tax inspector, accountant, or regulator temporary
        /// access to the viewing key without revealing the spending key or other transactions.
        ///
        /// The viewing key must be encrypted with the delegate's public key before calling.
        #[pallet::call_index(3)]
        #[pallet::weight(T::WeightInfo::delegate_viewing_key())]
        pub fn delegate_viewing_key(
            origin: OriginFor<T>,
            delegate: T::AccountId,
            valid_from: BlockNumberFor<T>,
            valid_until: Option<BlockNumberFor<T>>,
            encrypted_viewing_key: [u8; 64],
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;

            ensure!(who != delegate, Error::<T>::CannotDelegateToSelf);

            let delegation = ViewingKeyDelegation {
                delegate: delegate.clone(),
                valid_from,
                valid_until,
                encrypted_viewing_key,
            };

            ViewingKeyDelegations::<T>::try_mutate(&who, |delegations| {
                delegations.try_push(delegation).map_err(|_| Error::<T>::TooManyDelegations)
            })?;

            Self::deposit_event(Event::ViewingKeyDelegated { owner: who, delegate, valid_until });
            Ok(())
        }

        /// Send the native token to a stealth address on another parachain.
        ///
        /// Atomically does two things:
        /// 1. Sends an XCM teleport message — tokens arrive directly at the stealth address
        /// 2. Writes the announcement locally — the recipient scans this chain
        ///
        /// The recipient on the dest parachain receives the tokens, and finds the
        /// announcement by scanning ViewTagIndex on THIS parachain.
        ///
        /// Parameters:
        /// - `dest_para_id`    : destination parachain ID (e.g. 1000 for Asset Hub)
        /// - `stealth_address` : 32-byte address on the destination (AccountId32)
        /// - `amount`          : amount in planck of the native token
        /// - `ephemeral_pubkey`: R = r × G₁ (BN254, 64 bytes)
        /// - `view_tag`        : first 2 bytes of hash(r × V)
        /// - `metadata`        : optional metadata (32 bytes)
        #[pallet::call_index(4)]
        #[pallet::weight(T::WeightInfo::send_stealth_xcm())]
        pub fn send_stealth_xcm(
            origin: OriginFor<T>,
            dest_para_id: u32,
            stealth_address: [u8; 32],
            amount: u128,
            ephemeral_pubkey: [u8; 64],
            view_tag: [u8; 2],
            metadata: [u8; 32],
        ) -> DispatchResult {
            let _who = ensure_signed(origin)?;

            ensure!(amount > 0, Error::<T>::ZeroAmount);

            // ── 1. Build XCM message ──────────────────────────────────────────
            let dest: Location = Location::new(1, [Junction::Parachain(dest_para_id)]);

            let beneficiary: Location = Location::new(
                0,
                [Junction::AccountId32 { network: None, id: stealth_address }],
            );

            let asset = Asset {
                id: AssetId(Location::parent()),
                fun: Fungible(amount),
            };

            // Teleport: source para → relay → dest para
            // Destination chain receives `ReceiveTeleportedAsset` and deposits to the stealth address.
            let xcm: Xcm<()> = Xcm(vec![
                ReceiveTeleportedAsset(vec![asset.clone()].into()),
                ClearOrigin,
                BuyExecution {
                    fees: asset,
                    weight_limit: WeightLimit::Unlimited,
                },
                DepositAsset {
                    assets: Wild(AllCounted(1)),
                    beneficiary,
                },
            ]);

            // Validate and send
            let (ticket, _) = T::XcmSender::validate(
                &mut Some(dest),
                &mut Some(xcm),
            ).map_err(|_| Error::<T>::XcmSendFailed)?;

            T::XcmSender::deliver(ticket)
                .map_err(|_| Error::<T>::XcmSendFailed)?;

            // ── 2. Write announcement locally ────────────────────────────────
            // The recipient scans ViewTagIndex on this chain to find their payment.
            let nonce = AnnouncementNonce::<T>::get();

            let stealth_account = T::AccountId::decode(
                &mut stealth_address.as_ref()
            ).map_err(|_| Error::<T>::XcmSendFailed)?;

            Announcements::<T>::insert(nonce, Announcement {
                ephemeral_pubkey,
                view_tag,
                stealth_address: stealth_account,
                metadata,
            });

            ViewTagIndex::<T>::try_mutate(view_tag, |nonces| {
                nonces.try_push(nonce).map_err(|_| Error::<T>::ViewTagIndexFull)
            })?;

            AnnouncementNonce::<T>::put(nonce.saturating_add(1));

            Self::deposit_event(Event::StealthXcmSent {
                dest_para_id,
                stealth_address,
                amount,
                announcement_nonce: nonce,
            });

            Ok(())
        }

        /// Withdraw funds from a stealth address with gas sponsorship.
        ///
        /// This is a **permissionless** operation — anyone (relayer, frontend) can
        /// send this transaction on behalf of the user. The user only needs to
        /// sign the message offline using the private key of the stealth address.
        ///
        /// ## Flow
        ///
        /// 1. Stealth key holder signs offline: `keccak256("PrivyDot::withdraw:v1" ‖ stealth_addr ‖ destination_addr)`
        /// 2. Relayer sends this extrinsic (pays the Substrate tx fee from their account)
        /// 3. Pallet verifies the ECDSA signature:
        ///    - Recover uncompressed pubkey (64B) from the signature
        ///    - Compress to 33B (0x02/0x03 prefix + x coordinate)
        ///    - `blake2_256(compressed)` must equal `stealth_address`
        /// 4. Pallet releases `WithdrawalFee` from the sponsor's hold → transfer sponsor → relayer
        /// 5. Pallet transfers the entire stealth balance → destination
        ///
        /// ## Security
        ///
        /// - Replay protection: the signature includes destination and asset_id; after the first
        ///   execution the stealth balance is 0, so a second attempt fails with `ZeroAmount`.
        /// - Sponsor can be the same as the relayer (self-sponsorship).
        /// - `v` byte of the signature is normalized: accepts both 0/1 and 27/28 (Ethereum format).
        /// - `asset_id = None` → withdraws the native token (PAS/DOT).
        /// - `asset_id = Some(id)` → withdraws a pallet-assets token (rSDC, USDC...).
        #[pallet::call_index(5)]
        #[pallet::weight(T::WeightInfo::withdraw_from_stealth())]
        pub fn withdraw_from_stealth(
            origin: OriginFor<T>,
            stealth_address: [u8; 32],
            destination: T::AccountId,
            sig: [u8; 65],
            sponsor: T::AccountId,
            asset_id: Option<T::AssetId>,
            amount: Option<u128>, // None = entire balance, Some(n) = exact amount
        ) -> DispatchResult {
            let relayer = ensure_signed(origin)?;

            // ── 1. Verify ECDSA proof of ownership ───────────────────────────

            // Message includes asset_id and amount to prevent signature reuse
            let msg = Self::withdrawal_message(&stealth_address, &destination, &asset_id, &amount);
            let msg_hash = sp_io::hashing::blake2_256(&msg);

            // Normalize v byte: Ethereum uses 27/28, sp_io expects 0/1
            let mut sig_norm = sig;
            if sig_norm[64] >= 27 {
                sig_norm[64] -= 27;
            }

            // Recover uncompressed pubkey (64B: x‖y without 0x04 prefix)
            let pk = sp_io::crypto::secp256k1_ecdsa_recover(&sig_norm, &msg_hash)
                .map_err(|_| Error::<T>::InvalidProof)?;

            // Compress: 0x02 if y is even, 0x03 if y is odd
            let mut compressed = [0u8; 33];
            compressed[0] = if pk[63] & 1 == 0 { 0x02 } else { 0x03 };
            compressed[1..].copy_from_slice(&pk[..32]);

            // Substrate stealth address = blake2_256(compressed_secp256k1_pubkey)
            let recovered = sp_io::hashing::blake2_256(&compressed);
            ensure!(recovered == stealth_address, Error::<T>::InvalidProof);

            // ── 2. Prepare fee and check sponsor pool ─────────────────────────

            let fee = T::WithdrawalFee::get();
            let sponsor_deposit = GasSponsorPool::<T>::get(&sponsor);
            ensure!(sponsor_deposit >= fee, Error::<T>::InsufficientSponsorFunds);

            let fee_balance: BalanceOf<T> = fee.saturated_into();

            // ── 3. Decode stealth address ─────────────────────────────────────

            let stealth_account = T::AccountId::decode(&mut stealth_address.as_ref())
                .map_err(|_| Error::<T>::InvalidProof)?;

            // ── 4. Release fee from sponsor's hold → relayer ──────────────────

            let hold_reason: T::RuntimeHoldReason = HoldReason::SponsorPool.into();
            T::NativeBalance::release(&hold_reason, &sponsor, fee_balance, Precision::Exact)?;
            T::NativeBalance::transfer(&sponsor, &relayer, fee_balance, Preservation::Preserve)?;
            GasSponsorPool::<T>::mutate(&sponsor, |d| *d = d.saturating_sub(fee));

            // ── 5. Transfer stealth balance to destination ────────────────────

            match asset_id.clone() {
                None => {
                    // Native token (PAS/DOT)
                    let stealth_balance = T::NativeBalance::balance(&stealth_account);
                    ensure!(stealth_balance > Zero::zero(), Error::<T>::ZeroAmount);
                    let (transfer_amount, preservation): (BalanceOf<T>, Preservation) = match amount {
                        Some(n) => (n.saturated_into(), Preservation::Preserve),
                        None => (stealth_balance, Preservation::Expendable),
                    };
                    ensure!(transfer_amount <= stealth_balance, Error::<T>::ZeroAmount);
                    T::NativeBalance::transfer(
                        &stealth_account,
                        &destination,
                        transfer_amount,
                        preservation,
                    )?;
                }
                Some(ref id) => {
                    // pallet-assets token (rSDC, USDC, ...)
                    let asset_balance: AssetBalanceOf<T> =
                        <T::Assets as FungiblesInspect<T::AccountId>>::balance(
                            id.clone(),
                            &stealth_account,
                        );
                    ensure!(asset_balance > 0u32.into(), Error::<T>::ZeroAmount);
                    let (transfer_amount, preservation): (AssetBalanceOf<T>, Preservation) = match amount {
                        Some(n) => (n.saturated_into(), Preservation::Preserve),
                        None => (asset_balance, Preservation::Expendable),
                    };
                    ensure!(transfer_amount <= asset_balance, Error::<T>::ZeroAmount);
                    <T::Assets as FungiblesMutate<T::AccountId>>::transfer(
                        id.clone(),
                        &stealth_account,
                        &destination,
                        transfer_amount,
                        preservation,
                    )?;
                }
            }

            Self::deposit_event(Event::StealthWithdrawal {
                stealth_address: stealth_account,
                destination,
                relayer,
                sponsor,
                sponsor_fee: fee,
                asset_id,
            });

            Ok(())
        }

        /// Send a pallet-assets token (USDC, etc.) to a stealth address on another parachain.
        ///
        /// Atomically:
        /// 1. Burns the asset from the sender on this chain
        /// 2. Sends an XCM `ReceiveTeleportedAsset` message to the destination parachain
        /// 3. Writes the announcement on this chain — the recipient scans this chain
        ///
        /// The destination parachain must have the same asset (same asset ID, same pallet index)
        /// and must be a trusted teleport partner (`IsTeleporter = Everything`).
        #[pallet::call_index(6)]
        #[pallet::weight(T::WeightInfo::send_stealth_xcm())]
        pub fn send_stealth_asset_xcm(
            origin: OriginFor<T>,
            asset_id: T::AssetId,
            dest_para_id: u32,
            stealth_address: [u8; 32],
            amount: u128,
            ephemeral_pubkey: [u8; 64],
            view_tag: [u8; 2],
            metadata: [u8; 32],
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;
            ensure!(amount > 0, Error::<T>::ZeroAmount);

            // ── 1. Burn asset from sender ─────────────────────────────────────
            let amount_balance: AssetBalanceOf<T> = amount.saturated_into();
            <T::Assets as FungiblesMutate<T::AccountId>>::burn_from(
                asset_id.clone(),
                &who,
                amount_balance,
                Preservation::Expendable,
                Precision::Exact,
                Fortitude::Polite,
            )?;

            // ── 2. Build XCM Transact message ────────────────────────────────
            // Encode the receive_stealth_asset_xcm call on the destination chain.
            // Both chains use the same runtime, so encoding is identical.
            let dest: Location = Location::new(1, [Junction::Parachain(dest_para_id)]);

            let receive_call: <T as Config>::RuntimeCall = Call::<T>::receive_stealth_asset_xcm {
                asset_id: asset_id.clone(),
                stealth_address,
                amount,
                ephemeral_pubkey,
                view_tag,
                metadata,
            }.into();

            let xcm: Xcm<()> = Xcm(vec![
                UnpaidExecution { weight_limit: WeightLimit::Unlimited, check_origin: None },
                Transact {
                    origin_kind: OriginKind::SovereignAccount,
                    call: receive_call.encode().into(),
                    fallback_max_weight: None,
                },
            ]);

            let (ticket, _) = T::XcmSender::validate(
                &mut Some(dest),
                &mut Some(xcm),
            ).map_err(|_| Error::<T>::XcmSendFailed)?;

            T::XcmSender::deliver(ticket)
                .map_err(|_| Error::<T>::XcmSendFailed)?;

            // ── 3. Write announcement locally ────────────────────────────────
            let nonce = AnnouncementNonce::<T>::get();

            let stealth_account = T::AccountId::decode(&mut stealth_address.as_ref())
                .map_err(|_| Error::<T>::XcmSendFailed)?;

            Announcements::<T>::insert(nonce, Announcement {
                ephemeral_pubkey,
                view_tag,
                stealth_address: stealth_account,
                metadata,
            });

            ViewTagIndex::<T>::try_mutate(view_tag, |nonces| {
                nonces.try_push(nonce).map_err(|_| Error::<T>::ViewTagIndexFull)
            })?;

            AnnouncementNonce::<T>::put(nonce.saturating_add(1));

            Self::deposit_event(Event::StealthAssetXcmSent {
                dest_para_id,
                asset_id,
                stealth_address,
                amount,
                announcement_nonce: nonce,
            });

            Ok(())
        }

        /// Receives an XCM stealth asset transfer and mints the token to the stealth address.
        ///
        /// This extrinsic is called automatically by the destination parachain via XCM Transact.
        /// Users should not call it directly.
        ///
        /// The call comes from the sender's sovereign account — `ensure_signed` accepts it
        /// because a sovereign account is a valid AccountId on the destination.
        #[pallet::call_index(7)]
        #[pallet::weight(T::WeightInfo::announce())]
        pub fn receive_stealth_asset_xcm(
            origin: OriginFor<T>,
            asset_id: T::AssetId,
            stealth_address: [u8; 32],
            amount: u128,
            ephemeral_pubkey: [u8; 64],
            view_tag: [u8; 2],
            metadata: [u8; 32],
        ) -> DispatchResult {
            let _relayer = ensure_signed(origin)?;
            ensure!(amount > 0, Error::<T>::ZeroAmount);

            // ── 1. Mint asset to stealth address ─────────────────────────────
            let stealth_account = T::AccountId::decode(&mut stealth_address.as_ref())
                .map_err(|_| Error::<T>::InvalidProof)?;

            let amount_balance: AssetBalanceOf<T> = amount.saturated_into();
            <T::Assets as FungiblesMutate<T::AccountId>>::mint_into(
                asset_id.clone(),
                &stealth_account,
                amount_balance,
            )?;

            // ── 2. Write announcement ─────────────────────────────────────────
            let nonce = AnnouncementNonce::<T>::get();

            Announcements::<T>::insert(nonce, Announcement {
                ephemeral_pubkey,
                view_tag,
                stealth_address: stealth_account.clone(),
                metadata,
            });

            ViewTagIndex::<T>::try_mutate(view_tag, |nonces| {
                nonces.try_push(nonce).map_err(|_| Error::<T>::ViewTagIndexFull)
            })?;

            AnnouncementNonce::<T>::put(nonce.saturating_add(1));

            Self::deposit_event(Event::Announced {
                nonce,
                ephemeral_pubkey,
                view_tag,
                stealth_address: stealth_account,
            });

            Ok(())
        }
    }

    // =========================================================================
    // INTERNAL HELPERS
    // =========================================================================

    impl<T: Config> Pallet<T> {
        /// Constructs the message that the stealth key holder signs for withdrawal.
        ///
        /// Format: `"PrivyDot::withdraw:v2" ‖ stealth[32] ‖ dest_encoded ‖ asset_id_encoded ‖ amount_encoded`
        ///
        /// `asset_id = None` → native token; `Some(id)` → pallet-assets token.
        /// `amount = None` → entire balance; `Some(n)` → exact amount.
        /// Including asset_id and amount prevents signature reuse.
        pub(crate) fn withdrawal_message(
            stealth: &[u8; 32],
            dest: &T::AccountId,
            asset_id: &Option<T::AssetId>,
            amount: &Option<u128>,
        ) -> Vec<u8> {
            const PREFIX: &[u8] = b"PrivyDot::withdraw:v2";
            let dest_bytes = dest.encode();
            let asset_bytes = asset_id.encode();
            let amount_bytes = amount.encode();
            let mut msg = Vec::with_capacity(
                PREFIX.len() + 32 + dest_bytes.len() + asset_bytes.len() + amount_bytes.len(),
            );
            msg.extend_from_slice(PREFIX);
            msg.extend_from_slice(stealth);
            msg.extend_from_slice(&dest_bytes);
            msg.extend_from_slice(&asset_bytes);
            msg.extend_from_slice(&amount_bytes);
            msg
        }
    }

    // =========================================================================
    // PUBLIC HELPERS (for XCM and RPC)
    // =========================================================================

    impl<T: Config> Pallet<T> {
        /// Return the stealth meta-address for the given account.
        /// Called by other parachains via XCM `Transact` message.
        pub fn resolve_meta_address(account: &T::AccountId) -> Option<StealthMetaAddress> {
            StealthMetaAddressRegistry::<T>::get(account)
        }

        /// Return the nonces of all announcements with the given view tag.
        /// This is the RPC method used by the recipient's wallet for efficient scanning.
        pub fn get_announcements_by_view_tag(view_tag: [u8; 2]) -> Vec<u64> {
            ViewTagIndex::<T>::get(view_tag).into_inner()
        }

        /// Return a specific announcement by nonce.
        pub fn get_announcement(nonce: u64) -> Option<Announcement<T::AccountId>> {
            Announcements::<T>::get(nonce)
        }
    }
}
//! # Pallet Stealth Addresses
//!
//! Implementacija ECPDKSAP (Elliptic Curve Pairing Dual Key Stealth Address Protocol)
//! na nivou Substrate runtime-a.
//!
//! ## Šta ovaj palet radi
//!
//! - **Registar meta-adresa** — korisnici registruju (spending_pubkey, viewing_pubkey) jednom;
//!   svi parachain-ovi u Polkadot mreži ih mogu čitati putem XCM-a.
//! - **Indeks objava** — pošiljalac poziva `announce` nakon transakcije; palet automatski
//!   indeksira objavu po view tagu, pa primalac skenira samo ~1/65536 svih objava.
//! - **Gas sponzorstvo** — stealth adresa nema nativni token; sponzori deponuju DOT u pool,
//!   a palet pokriva naknadu pri povlačenju i uzima proviziju iz povučenih sredstava.
//! - **Delegacija viewing key-a** — primalac može delegirati viewing key revizoru/inspektoru
//!   za vremenski ograničen period bez otkrivanja spending key-a.
//!
//! ## Integracija sa EVM ugovorom
//!
//! Postojeći ECPDKSAP PVM ugovor (`contracts/rust/`) emituje `Announcement` evente.
//! Precompile (buduća faza) ce mostiti EVM pozive ka ovim extrinsicima.
//! Za sada, extrinsici se pozivaju direktno putem Substrate transakcija ili XCM-a.

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

    /// Tip bilansa nativnog tokena izveden iz `NativeBalance` asociranog tipa.
    pub(crate) type BalanceOf<T> = <<T as Config>::NativeBalance as FungibleInspect<
        <T as frame_system::Config>::AccountId,
    >>::Balance;

    /// Tip bilansa pallet-assets tokena izveden iz `Assets` asociranog tipa.
    pub(crate) type AssetBalanceOf<T> = <<T as Config>::Assets as fungibles::Inspect<
        <T as frame_system::Config>::AccountId,
    >>::Balance;

    // =========================================================================
    // TIPOVI I STRUKTURE
    // =========================================================================

    /// Stealth meta-adresa — javni deo para ključeva korisnika.
    ///
    /// Protokol: ECPDKSAP Protocol 3
    /// - `spending_pubkey` : K = k × G  na Secp256k1 (33 bajta, kompresovano)
    /// - `viewing_pubkey`  : V = v × G₁ na BN254 G1   (64 bajta, nekompresovano)
    /// - `scheme_id`       : identifikator šeme (ECPDKSAP koristi 2901)
    #[derive(Clone, Encode, Decode, TypeInfo, MaxEncodedLen, RuntimeDebug, PartialEq)]
    pub struct StealthMetaAddress {
        /// Javni ključ za trošenje — Secp256k1, 33 bajta kompresovano
        pub spending_pubkey: [u8; 33],
        /// Javni ključ za gledanje — BN254 G1, 64 bajta nekompresovano (x ++ y)
        pub viewing_pubkey: [u8; 64],
        /// Identifikator šeme (npr. 2901 za ECPDKSAP)
        pub scheme_id: u32,
    }

    /// Objava transakcije — podatak koji pošiljalac upisuje na lanac.
    ///
    /// Primalac skenira `ViewTagIndex` za svoj view tag, pa za svaki pogodak
    /// radi pun kriptografski test koristeći `ephemeral_pubkey` i svoj `viewing_key`.
    #[derive(Clone, Encode, Decode, TypeInfo, MaxEncodedLen, RuntimeDebug)]
    pub struct Announcement<AccountId> {
        /// Efemerni javni ključ R = r × G₁ — BN254 G1, 64 bajta
        pub ephemeral_pubkey: [u8; 64],
        /// View tag — prvih 2 bajta od hash(r × V)
        /// Smanjuje broj lažnih poklapanja na ~1/65536 u poređenju sa punim skeniranjem.
        pub view_tag: [u8; 2],
        /// Stealth adresa na koju su sredstva poslata
        pub stealth_address: AccountId,
        /// Opcionalni metapodaci (tip tokena, iznos itd.) — 32 bajta
        pub metadata: [u8; 32],
    }

    /// Delegacija viewing key-a — compliance sloj protokola.
    ///
    /// Korisnik može delegirati viewing key inspektoru/računovođi za određeni
    /// vremenski period. Delegat može VIDETI transakcije ali NE može trošiti.
    /// Viewing key je enkriptovan javnim ključem delegata pre upisa na lanac.
    #[derive(Clone, Encode, Decode, TypeInfo, MaxEncodedLen, RuntimeDebug)]
    pub struct ViewingKeyDelegation<AccountId, BlockNumber> {
        /// Kome je delegiran pristup
        pub delegate: AccountId,
        /// Od kog bloka važi
        pub valid_from: BlockNumber,
        /// Do kog bloka važi (None = bez isteka)
        pub valid_until: Option<BlockNumber>,
        /// Viewing key enkriptovan javnim ključem delegata (ECIES ili slično)
        pub encrypted_viewing_key: [u8; 64],
    }

    // =========================================================================
    // HOLD REASON — razlog zaključavanja sredstava sponzora
    // =========================================================================

    /// Razlog zašto su sponzorova sredstva zaključana u Balances paletu.
    ///
    /// Runtime automatski kombinuje `HoldReason` enume svih paleta u
    /// `RuntimeHoldReason` — isti mehanizam koji koriste `pallet_staking`,
    /// `pallet_democracy` itd.
    #[pallet::composite_enum]
    pub enum HoldReason {
        /// Sredstva zaključana kao depozit u gas sponsor pool-u.
        SponsorPool,
    }

    // =========================================================================
    // KONFIGURACIJA PALETA
    // =========================================================================

    #[pallet::config]
    pub trait Config: frame_system::Config<RuntimeEvent: From<Event<Self>>> {

        /// Maksimalan broj objava po view tagu (globalno kroz ceo lanac).
        #[pallet::constant]
        type MaxAnnouncementsPerViewTag: Get<u32>;

        /// Maksimalan broj delegacija viewing key-a po korisniku.
        #[pallet::constant]
        type MaxDelegationsPerUser: Get<u32>;

        /// Minimalan depozit za gas sponzorstvo (u planck-ovima).
        #[pallet::constant]
        type MinSponsorDeposit: Get<u128>;

        /// Naknada koja se oslobađa sponzoru i prosleđuje relayeru pri svakom
        /// povlačenju sa stealth adrese (u planck-ovima).
        #[pallet::constant]
        type WithdrawalFee: Get<u128>;

        /// Interfejs ka nativnom tokenu — za zaključavanje i transfer sredstava.
        ///
        /// U runtimeu se postavlja na `Balances` (pallet_balances instancu).
        /// Mora podržavati `hold`/`release` mehanizam za gas sponsor pool.
        type NativeBalance: FungibleInspect<Self::AccountId>
            + FungibleMutate<Self::AccountId>
            + MutateHold<Self::AccountId, Reason = Self::RuntimeHoldReason>;

        /// Runtime-nivo hold reason enum koji uključuje naš `HoldReason`.
        type RuntimeHoldReason: From<HoldReason>;

        /// Identifikator asset-a u pallet-assets (u runtimeu je `u32`).
        /// `Into<u64>` je potreban za XCM GeneralIndex enkodovanje.
        type AssetId: Member + Parameter + MaxEncodedLen + Clone + Into<u64>;

        /// Indeks Assets paleta u construct_runtime! (npr. 52).
        /// Koristi se za konstruisanje XCM asset location-a.
        #[pallet::constant]
        type AssetsPalletIndex: Get<u8>;

        /// Interfejs ka pallet-assets — za transfer ERC20-kompatibilnih tokena
        /// (npr. USDC, rSDC) sa stealth adrese.
        ///
        /// Gas sponzorstvo uvek ide u nativnom tokenu (PAS/DOT);
        /// ovaj tip pokriva samo transfer samog asset-a.
        type Assets: fungibles::Inspect<Self::AccountId, AssetId = Self::AssetId>
            + fungibles::Mutate<Self::AccountId>;

        /// XCM sender — za slanje cross-chain poruka.
        type XcmSender: SendXcm;

        /// RuntimeCall tip — potreban za enkodovanje Transact XCM poziva.
        type RuntimeCall: codec::Encode + From<Call<Self>>;

        /// Težine operacija.
        type WeightInfo: WeightInfo;
    }

    // =========================================================================
    // STORAGE
    // =========================================================================

    #[pallet::pallet]
    pub struct Pallet<T>(_);

    /// Registar stealth meta-adresa.
    ///
    /// AccountId → StealthMetaAddress
    ///
    /// Prednost nad EVM registrom: dostupan svim parachain-ovima putem XCM-a,
    /// bez EVM overhead-a, direktno čitljiv iz runtime API-ja.
    #[pallet::storage]
    pub type StealthMetaAddressRegistry<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        StealthMetaAddress,
        OptionQuery,
    >;

    /// Objave — centralna lista, indeksirana po nonce-u.
    ///
    /// Primalac čita `ViewTagIndex` za filtriranje, pa po potrebi učitava
    /// konkretnu objavu iz ovog storage-a.
    #[pallet::storage]
    pub type Announcements<T: Config> = StorageMap<
        _,
        Twox64Concat,
        u64,
        Announcement<T::AccountId>,
        OptionQuery,
    >;

    /// Sekundarni indeks: view_tag → lista nonce-ova objava sa tim tagom.
    ///
    /// Ovo je ključna prednost nad pristupom pametnog ugovora:
    /// runtime automatski indeksira pri upisu, primalac ne skenira sve objave.
    #[pallet::storage]
    pub type ViewTagIndex<T: Config> = StorageMap<
        _,
        Twox64Concat,
        [u8; 2],
        BoundedVec<u64, T::MaxAnnouncementsPerViewTag>,
        ValueQuery,
    >;

    /// Globalni monotono-rastući nonce za objave.
    #[pallet::storage]
    pub type AnnouncementNonce<T: Config> = StorageValue<_, u64, ValueQuery>;

    /// Pool za sponzorstvo gasa.
    ///
    /// Sponzor → deponovani iznos u planck-ovima.
    /// Koristi se za plaćanje naknada pri povlačenju sa stealth adrese
    /// (koja sama nema nativni token).
    #[pallet::storage]
    pub type GasSponsorPool<T: Config> = StorageMap<
        _,
        Blake2_128Concat,
        T::AccountId,
        u128,
        ValueQuery,
    >;

    /// Delegacije viewing key-a po vlasniku.
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
    // EVENTI
    // =========================================================================

    #[pallet::event]
    #[pallet::generate_deposit(pub(super) fn deposit_event)]
    pub enum Event<T: Config> {
        /// Korisnik je registrovao stealth meta-adresu.
        MetaAddressRegistered {
            who: T::AccountId,
            scheme_id: u32,
        },
        /// Korisnik je ažurirao stealth meta-adresu.
        MetaAddressUpdated {
            who: T::AccountId,
            scheme_id: u32,
        },
        /// Nova stealth transakcija je objavljena.
        /// Primaocev wallet skenira ovaj event filtrirajući po view tagu.
        Announced {
            nonce: u64,
            ephemeral_pubkey: [u8; 64],
            view_tag: [u8; 2],
            stealth_address: T::AccountId,
        },
        /// Sponzor je deponovao sredstva u gas pool.
        GasSponsorDeposited {
            sponsor: T::AccountId,
            amount: u128,
        },
        /// Viewing key delegiran drugom nalogu.
        ViewingKeyDelegated {
            owner: T::AccountId,
            delegate: T::AccountId,
            valid_until: Option<BlockNumberFor<T>>,
        },
        /// Cross-chain stealth plaćanje pallet-assets tokena (USDC itd.) poslato.
        StealthAssetXcmSent {
            dest_para_id: u32,
            asset_id: T::AssetId,
            stealth_address: [u8; 32],
            amount: u128,
            announcement_nonce: u64,
        },
        /// Cross-chain stealth plaćanje nativnog tokena poslato.
        StealthXcmSent {
            dest_para_id: u32,
            stealth_address: [u8; 32],
            amount: u128,
            announcement_nonce: u64,
        },
        /// Sredstva povučena sa stealth adrese uz gas sponzorstvo.
        ///
        /// Relayer je platio Substrate tx naknadu; sponzor mu je refundirao
        /// `sponsor_fee` iz svog pool-a; destination dobija ceo stealth balans.
        /// `asset_id = None` znači nativni token (PAS/DOT);
        /// `asset_id = Some(id)` znači pallet-assets token (rSDC, USDC...).
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
    // GREŠKE
    // =========================================================================

    #[pallet::error]
    pub enum Error<T> {
        /// Meta-adresa nije pronađena za dati nalog.
        MetaAddressNotFound,
        /// View tag indeks je pun za dati tag.
        ViewTagIndexFull,
        /// Nedovoljno sredstava u gas sponsor pool-u.
        InsufficientSponsorFunds,
        /// Dostignut maksimalan broj delegacija za ovog korisnika.
        TooManyDelegations,
        /// Korisnik pokušava da delegira samom sebi.
        CannotDelegateToSelf,
        /// Depozit je ispod minimalnog praga.
        DepositBelowMinimum,
        /// XCM poruka nije mogla da se pošalje.
        XcmSendFailed,
        /// Iznos mora biti veći od nule.
        ZeroAmount,
        /// ECDSA dokaz vlasništva nad stealth adresom nije validan.
        ///
        /// Može biti: loš potpis, recovery failure, ili recovered adresa
        /// ne odgovara prosleđenoj stealth adresi.
        InvalidProof,
    }

    // =========================================================================
    // EXTRINSICS
    // =========================================================================

    #[pallet::call]
    impl<T: Config> Pallet<T> {
        /// Registruj ili ažuriraj stealth meta-adresu.
        ///
        /// Primalac poziva jednom da objavi (spending_pubkey, viewing_pubkey).
        /// Naknadni poziv ažurira postojeću meta-adresu (za rotaciju ključeva).
        ///
        /// Tok: korisnik generiše k, v → K = k×G (Secp256k1), V = v×G₁ (BN254) → poziva ovu funkciju.
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

        /// Objavi stealth transakciju.
        ///
        /// Pošiljalac poziva nakon slanja sredstava na stealth adresu.
        /// Runtime automatski indeksira objavu po view tagu.
        ///
        /// Tok protokola (Protocol 3):
        /// 1. Pošiljalac generiše efemerni ključ r → R = r × G₁
        /// 2. Izračuna b = hash(r × V), stealth_addr = keccak(K + b×G)[12:]
        /// 3. Izračuna view_tag = hash(r × V)[0..2]
        /// 4. Šalje sredstva na stealth_addr
        /// 5. Pozove ovu funkciju sa (R, view_tag, stealth_addr)
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

            // Automatski indeksiraj po view tagu — primalac filtrira bez skeniranja svega
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

        /// Deponuj sredstva u gas sponsor pool.
        ///
        /// Sredstva **ostaju u sponzorovom nalogu** ali su zaključana pomoću
        /// Balances `hold` mehanizma (`HoldReason::SponsorPool`). Ovo znači:
        /// - Sponzor može videti zaključana sredstva u svom nalogu
        /// - Sredstva se ne mogu potrošiti dok god su zaključana
        /// - Palet ih oslobađa atomski pri svakom `withdraw_from_stealth` pozivu
        ///
        /// Prednost nad transferom na poseban pool nalog: nema `PalletId`,
        /// nema `ExistentialDeposit` problema, jasna proveniencija sredstava.
        #[pallet::call_index(2)]
        #[pallet::weight(T::WeightInfo::sponsor_gas())]
        pub fn sponsor_gas(
            origin: OriginFor<T>,
            amount: u128,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;

            ensure!(amount >= T::MinSponsorDeposit::get(), Error::<T>::DepositBelowMinimum);

            // Konvertuj u BalanceOf<T> — saturated_into je bezbedan jer je
            // BalanceOf<T> uvek AtLeast32BitUnsigned, a amount je u128.
            let amount_balance: BalanceOf<T> = amount.saturated_into();

            // Zaključaj sredstva u sponzorovom nalogu.
            // Ako nema dovoljno slobodnih sredstava, Balances vraća grešku.
            let hold_reason: T::RuntimeHoldReason = HoldReason::SponsorPool.into();
            T::NativeBalance::hold(&hold_reason, &who, amount_balance)
                .map_err(|_| Error::<T>::InsufficientSponsorFunds)?;

            // Ažuriraj pool evidenciju (u128 za lakšu upotrebu u logici)
            GasSponsorPool::<T>::mutate(&who, |deposit| {
                *deposit = deposit.saturating_add(amount);
            });

            Self::deposit_event(Event::GasSponsorDeposited { sponsor: who, amount });
            Ok(())
        }

        /// Povuci sredstva sa stealth adrese uz gas sponzorstvo.
        ///
        /// Ovo je **permissionless** operacija — bilo ko (relayer, frontend) može
        /// da pošalje ovu transakciju u ime korisnika. Korisnik samo treba da
        /// potpiše poruku offline, koristeći privatni ključ stealth adrese.
        ///
        /// ## Tok
        ///
        /// 1. Stealth key holder potpiše offline: `keccak256("PrivyDot::withdraw:v1" ‖ stealth_addr ‖ destination_addr)`
        /// 2. Relayer pošalje ovaj extrinsic (plaća Substrate tx naknadu iz svog naloga)
        /// 3. Palet verifikuje ECDSA potpis:
        ///    - Recover uncompressed pubkey (64B) iz potpisa
        ///    - Kompresuje u 33B (0x02/0x03 prefiks + x koordinata)
        ///    - `blake2_256(compressed)` mora biti jednako `stealth_address`
        /// 4. Palet oslobađa `WithdrawalFee` iz sponzorovog hold-a → transfer sponzor → relayer
        /// 5. Palet transferuje ceo stealth balans → destination
        ///
        /// ## Bezbednost
        ///
        /// - Replay zaštita: potpis uključuje destination i asset_id; posle prvog
        ///   izvršenja stealth balans je 0, pa drugi pokušaj pada na `ZeroAmount`.
        /// - Sponzor može biti isti kao relayer (self-sponsorship).
        /// - `v` bajt potpisa se normalizuje: prihvata i 0/1 i 27/28 (Ethereum format).
        /// - `asset_id = None` → povlači nativni token (PAS/DOT).
        /// - `asset_id = Some(id)` → povlači pallet-assets token (rSDC, USDC...).
        #[pallet::call_index(5)]
        #[pallet::weight(T::WeightInfo::withdraw_from_stealth())]
        pub fn withdraw_from_stealth(
            origin: OriginFor<T>,
            stealth_address: [u8; 32],
            destination: T::AccountId,
            sig: [u8; 65],
            sponsor: T::AccountId,
            asset_id: Option<T::AssetId>,
            amount: Option<u128>, // None = ceo balans, Some(n) = tačan iznos
        ) -> DispatchResult {
            let relayer = ensure_signed(origin)?;

            // ── 1. Verifikuj ECDSA dokaz vlasništva ──────────────────────────

            // Poruka uključuje asset_id i amount da spreči reupotrebu potpisa
            let msg = Self::withdrawal_message(&stealth_address, &destination, &asset_id, &amount);
            let msg_hash = sp_io::hashing::blake2_256(&msg);

            // Normalizuj v bajt: Ethereum koristi 27/28, sp_io očekuje 0/1
            let mut sig_norm = sig;
            if sig_norm[64] >= 27 {
                sig_norm[64] -= 27;
            }

            // Recover uncompressed pubkey (64B: x‖y bez 0x04 prefiksa)
            let pk = sp_io::crypto::secp256k1_ecdsa_recover(&sig_norm, &msg_hash)
                .map_err(|_| Error::<T>::InvalidProof)?;

            // Kompresuj: 0x02 ako je y paran, 0x03 ako je neparan
            let mut compressed = [0u8; 33];
            compressed[0] = if pk[63] & 1 == 0 { 0x02 } else { 0x03 };
            compressed[1..].copy_from_slice(&pk[..32]);

            // Substrate stealth adresa = blake2_256(compressed_secp256k1_pubkey)
            let recovered = sp_io::hashing::blake2_256(&compressed);
            ensure!(recovered == stealth_address, Error::<T>::InvalidProof);

            // ── 2. Pripremi fee i proveri sponzorov pool ──────────────────────

            let fee = T::WithdrawalFee::get();
            let sponsor_deposit = GasSponsorPool::<T>::get(&sponsor);
            ensure!(sponsor_deposit >= fee, Error::<T>::InsufficientSponsorFunds);

            let fee_balance: BalanceOf<T> = fee.saturated_into();

            // ── 3. Decode stealth adrese ──────────────────────────────────────

            let stealth_account = T::AccountId::decode(&mut stealth_address.as_ref())
                .map_err(|_| Error::<T>::InvalidProof)?;

            // ── 4. Oslobodi fee iz sponzorovog hold-a → relayer ───────────────

            let hold_reason: T::RuntimeHoldReason = HoldReason::SponsorPool.into();
            T::NativeBalance::release(&hold_reason, &sponsor, fee_balance, Precision::Exact)?;
            T::NativeBalance::transfer(&sponsor, &relayer, fee_balance, Preservation::Preserve)?;
            GasSponsorPool::<T>::mutate(&sponsor, |d| *d = d.saturating_sub(fee));

            // ── 5. Transfer stealth balansa na destination ────────────────────

            match asset_id.clone() {
                None => {
                    // Nativni token (PAS/DOT)
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
                    // pallet-assets token (rSDC, USDC...)
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

        /// Delegiraj viewing key drugom nalogu za selektivno otkrivanje.
        ///
        /// Korisnik može dati poreskom inspektoru, računovođi ili regulatoru privremeni
        /// pristup viewing key-u bez otkrivanja spending key-a ili drugih transakcija.
        ///
        /// Viewing key mora biti enkriptovan javnim ključem delegata pre poziva.
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

        /// Pošalji nativni token na stealth adresu na drugom parachain-u.
        ///
        /// Atomski radi dve stvari:
        /// 1. Šalje XCM teleport poruku — tokeni stižu direktno na stealth adresu
        /// 2. Upisuje announcement lokalno — primalac skenira ovaj lanac
        ///
        /// Primalac na dest parachain-u prima tokene, a objavu pronalazi
        /// skeniranjem ViewTagIndex na OVOM parachain-u.
        ///
        /// Parametri:
        /// - `dest_para_id`    : ID odredišnog parachain-a (npr. 1000 za Asset Hub)
        /// - `stealth_address` : 32-bajtna adresa na odredištu (AccountId32)
        /// - `amount`          : iznos u planck-ovima nativnog tokena
        /// - `ephemeral_pubkey`: R = r × G₁ (BN254, 64 bajta)
        /// - `view_tag`        : prva 2 bajta od hash(r × V)
        /// - `metadata`        : opcionalni metapodaci (32 bajta)
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

            // ── 1. Konstruiši XCM poruku ──────────────────────────────────────
            let dest: Location = Location::new(1, [Junction::Parachain(dest_para_id)]);

            let beneficiary: Location = Location::new(
                0,
                [Junction::AccountId32 { network: None, id: stealth_address }],
            );

            let asset = Asset {
                id: AssetId(Location::parent()),
                fun: Fungible(amount),
            };

            // Teleport: pošiljaoc para → relay → dest para
            // Destination chain prima `ReceiveTeleportedAsset` i deponuje na stealth adresu.
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

            // Validuj i pošalji
            let (ticket, _) = T::XcmSender::validate(
                &mut Some(dest),
                &mut Some(xcm),
            ).map_err(|_| Error::<T>::XcmSendFailed)?;

            T::XcmSender::deliver(ticket)
                .map_err(|_| Error::<T>::XcmSendFailed)?;

            // ── 2. Upiši announcement lokalno ─────────────────────────────────
            // Primalac skenira ViewTagIndex na ovom lancu da pronađe svoju uplatu.
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

        /// Pošalji pallet-assets token (USDC itd.) na stealth adresu na drugom parachain-u.
        ///
        /// Atomski:
        /// 1. Spaljuje (burn) asset od pošiljaoca na ovom lancu
        /// 2. Šalje XCM `ReceiveTeleportedAsset` poruку odredišnom parachain-u
        /// 3. Upisuje announcement na ovom lancu — primalac skenira ovaj lanac
        ///
        /// Odredišni parachain mora imati isti asset (isti asset ID, isti pallet index)
        /// i mora biti poverljiv teleport partner (`IsTeleporter = Everything`).
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

            // ── 1. Spali asset od pošiljaoca ─────────────────────────────────
            let amount_balance: AssetBalanceOf<T> = amount.saturated_into();
            <T::Assets as FungiblesMutate<T::AccountId>>::burn_from(
                asset_id.clone(),
                &who,
                amount_balance,
                Preservation::Expendable,
                Precision::Exact,
                Fortitude::Polite,
            )?;

            // ── 2. Konstruiši XCM Transact poruku ────────────────────────────
            // Enkoduj poziv receive_stealth_asset_xcm na odredišnom lancu.
            // Oba lanca koriste isti runtime, pa je enkodovanje identično.
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

            // ── 3. Upiši announcement lokalno ────────────────────────────────
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

        /// Prima XCM stealth asset transfer i mintuje token na stealth adresu.
        ///
        /// Ovaj extrinsic poziva odredišni parachain automatski putem XCM Transact.
        /// Ne treba ga korisnik pozivati direktno.
        ///
        /// Poziv dolazi od sovereign account-a pošiljaoca — `ensure_signed` prihvata
        /// jer je sovereign account validan AccountId na odredištu.
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

            // ── 1. Mintuj asset na stealth adresu ────────────────────────────
            let stealth_account = T::AccountId::decode(&mut stealth_address.as_ref())
                .map_err(|_| Error::<T>::InvalidProof)?;

            let amount_balance: AssetBalanceOf<T> = amount.saturated_into();
            <T::Assets as FungiblesMutate<T::AccountId>>::mint_into(
                asset_id.clone(),
                &stealth_account,
                amount_balance,
            )?;

            // ── 2. Upiši announcement ─────────────────────────────────────────
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
    // INTERNI HELPERI
    // =========================================================================

    impl<T: Config> Pallet<T> {
        /// Konstruiše poruku koju stealth key holder potpisuje za povlačenje.
        ///
        /// Format: `"PrivyDot::withdraw:v2" ‖ stealth[32] ‖ dest_encoded ‖ asset_id_encoded ‖ amount_encoded`
        ///
        /// `asset_id = None` → nativni token; `Some(id)` → pallet-assets token.
        /// `amount = None` → ceo balans; `Some(n)` → tačan iznos.
        /// Uključivanje asset_id i amount sprečava reupotrebu potpisa.
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
    // JAVNI HELPERI (za XCM i RPC)
    // =========================================================================

    impl<T: Config> Pallet<T> {
        /// Vrati stealth meta-adresu za dati nalog.
        /// Pozivaju ga drugi parachain-ovi putem XCM `Transact` poruke.
        pub fn resolve_meta_address(account: &T::AccountId) -> Option<StealthMetaAddress> {
            StealthMetaAddressRegistry::<T>::get(account)
        }

        /// Vrati nonce-ove svih objava sa datim view tagom.
        /// Ovo je RPC metoda koju primaocev wallet koristi za efikasno skeniranje.
        pub fn get_announcements_by_view_tag(view_tag: [u8; 2]) -> Vec<u64> {
            ViewTagIndex::<T>::get(view_tag).into_inner()
        }

        /// Vrati konkretnu objavu po nonce-u.
        pub fn get_announcement(nonce: u64) -> Option<Announcement<T::AccountId>> {
            Announcements::<T>::get(nonce)
        }
    }
}
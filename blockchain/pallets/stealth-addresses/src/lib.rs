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
    use polkadot_sdk::staging_xcm::prelude::*;

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
    // KONFIGURACIJA PALETA
    // =========================================================================

    #[pallet::config]
    pub trait Config: frame_system::Config<RuntimeEvent: From<Event<Self>>> {

        /// Maksimalan broj objava po view tagu (globalno kroz ceo lanac).
        /// Svakih 65536 objava prosečno jedna dobija isti tag, pa je 65535 prag od ~4 mlrd objava.
        #[pallet::constant]
        type MaxAnnouncementsPerViewTag: Get<u32>;

        /// Maksimalan broj delegacija viewing key-a po korisniku.
        #[pallet::constant]
        type MaxDelegationsPerUser: Get<u32>;

        /// Minimalan depozit za sponzorstvo gasa (u planck-ovima nativnog tokena).
        #[pallet::constant]
        type MinSponsorDeposit: Get<u128>;

        /// XCM sender — za slanje cross-chain poruka.
        /// U runtimeu se postavlja na `XcmRouter`.
        type XcmSender: SendXcm;

        /// Težine operacija
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
        /// Cross-chain stealth plaćanje poslato.
        StealthXcmSent {
            dest_para_id: u32,
            stealth_address: [u8; 32],
            amount: u128,
            announcement_nonce: u64,
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

            AnnouncementNonce::<T>::put(nonce + 1);

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
        /// Sponzori omogućavaju primaocu da povuče sredstva sa stealth adrese
        /// bez posedovanja nativnog tokena za naknade.
        /// TODO: implementirati stvarni transfer iz Balances paleta.
        #[pallet::call_index(2)]
        #[pallet::weight(T::WeightInfo::sponsor_gas())]
        pub fn sponsor_gas(
            origin: OriginFor<T>,
            amount: u128,
        ) -> DispatchResult {
            let who = ensure_signed(origin)?;

            ensure!(
                amount >= T::MinSponsorDeposit::get(),
                Error::<T>::DepositBelowMinimum
            );

            // TODO: pallet_balances::transfer(&who, &PalletId::into_account(), amount)
            GasSponsorPool::<T>::mutate(&who, |deposit| {
                *deposit = deposit.saturating_add(amount);
            });

            Self::deposit_event(Event::GasSponsorDeposited { sponsor: who, amount });
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

            AnnouncementNonce::<T>::put(nonce + 1);

            Self::deposit_event(Event::StealthXcmSent {
                dest_para_id,
                stealth_address,
                amount,
                announcement_nonce: nonce,
            });

            Ok(())
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
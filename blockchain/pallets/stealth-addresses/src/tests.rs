use crate::{
    mock::*,
    pallet::{Announcements, Error, Event, GasSponsorPool, StealthMetaAddressRegistry, ViewTagIndex},
};
use frame::testing_prelude::*;
use sp_core::{ecdsa, Pair as PairT};

// ─── Helpers za dummy podatke ────────────────────────────────────────────────

fn dummy_spending_pubkey() -> [u8; 33] {
    let mut k = [0u8; 33];
    k[0] = 0x02;
    k[1] = 42;
    k
}

fn dummy_viewing_pubkey() -> [u8; 64] {
    let mut v = [0u8; 64];
    v[0] = 1;
    v
}

fn dummy_ephemeral_pubkey() -> [u8; 64] {
    let mut r = [0u8; 64];
    r[0] = 2;
    r
}

/// Kreira ECDSA par ključeva i vraća:
/// - par (za potpisivanje u testu)
/// - stealth_address kao [u8; 32] = blake2_256(compressed_pk)
/// - decoded u64 AccountId (Substrate koristi prve 8 bajtova, little-endian)
fn make_stealth_key(seed: u8) -> (ecdsa::Pair, [u8; 32], u64) {
    let pair = ecdsa::Pair::from_seed(&[seed; 32]);
    let compressed: [u8; 33] = pair.public().0;
    let addr_bytes: [u8; 32] = sp_io::hashing::blake2_256(&compressed);
    let account_id = u64::from_le_bytes(addr_bytes[..8].try_into().unwrap());
    (pair, addr_bytes, account_id)
}

/// Gradi withdrawal poruku identično kao u paletu.
/// `asset_id = None` → nativni token; `Some(id)` → pallet-assets token.
fn build_withdrawal_msg(stealth: &[u8; 32], dest: u64, asset_id: Option<u32>) -> Vec<u8> {
    let dest_encoded = dest.encode();
    let asset_bytes = asset_id.encode();
    let mut msg = Vec::new();
    msg.extend_from_slice(b"PrivyDot::withdraw:v1");
    msg.extend_from_slice(stealth);
    msg.extend_from_slice(&dest_encoded);
    msg.extend_from_slice(&asset_bytes);
    msg
}

// ─── Postojeći testovi (registracija, announce, delegacija, sponsor) ─────────

#[test]
fn register_meta_address_works() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(StealthAddresses::register_stealth_meta_address(
            RuntimeOrigin::signed(1),
            dummy_spending_pubkey(),
            dummy_viewing_pubkey(),
            2901,
        ));
        let stored = StealthMetaAddressRegistry::<Test>::get(1).unwrap();
        assert_eq!(stored.scheme_id, 2901);
        System::assert_last_event(Event::MetaAddressRegistered { who: 1, scheme_id: 2901 }.into());
    });
}

#[test]
fn update_meta_address_emits_updated_event() {
    new_test_ext().execute_with(|| {
        assert_ok!(StealthAddresses::register_stealth_meta_address(
            RuntimeOrigin::signed(1),
            dummy_spending_pubkey(),
            dummy_viewing_pubkey(),
            2901,
        ));
        System::set_block_number(1);
        assert_ok!(StealthAddresses::register_stealth_meta_address(
            RuntimeOrigin::signed(1),
            dummy_spending_pubkey(),
            dummy_viewing_pubkey(),
            2901,
        ));
        System::assert_last_event(Event::MetaAddressUpdated { who: 1, scheme_id: 2901 }.into());
    });
}

#[test]
fn announce_stores_and_indexes() {
    new_test_ext().execute_with(|| {
        let view_tag = [0xAB, 0xCDu8];
        assert_ok!(StealthAddresses::announce(
            RuntimeOrigin::signed(2),
            dummy_ephemeral_pubkey(),
            view_tag,
            99u64,
            [0u8; 32],
        ));
        assert!(Announcements::<Test>::get(0).is_some());
        let nonces = ViewTagIndex::<Test>::get(view_tag);
        assert_eq!(nonces.into_inner(), vec![0u64]);
    });
}

#[test]
fn announce_increments_nonce() {
    new_test_ext().execute_with(|| {
        assert_ok!(StealthAddresses::announce(
            RuntimeOrigin::signed(1),
            dummy_ephemeral_pubkey(),
            [0x01, 0x01],
            10u64,
            [0u8; 32],
        ));
        assert_ok!(StealthAddresses::announce(
            RuntimeOrigin::signed(1),
            dummy_ephemeral_pubkey(),
            [0x01, 0x01],
            11u64,
            [0u8; 32],
        ));
        let nonces = ViewTagIndex::<Test>::get([0x01, 0x01u8]);
        assert_eq!(nonces.into_inner(), vec![0u64, 1u64]);
    });
}

#[test]
fn different_view_tags_dont_mix() {
    new_test_ext().execute_with(|| {
        assert_ok!(StealthAddresses::announce(
            RuntimeOrigin::signed(1),
            dummy_ephemeral_pubkey(),
            [0xAA, 0xBB],
            10u64,
            [0u8; 32],
        ));
        assert_ok!(StealthAddresses::announce(
            RuntimeOrigin::signed(1),
            dummy_ephemeral_pubkey(),
            [0xCC, 0xDD],
            11u64,
            [0u8; 32],
        ));
        assert_eq!(ViewTagIndex::<Test>::get([0xAA, 0xBBu8]).into_inner(), vec![0u64]);
        assert_eq!(ViewTagIndex::<Test>::get([0xCC, 0xDDu8]).into_inner(), vec![1u64]);
    });
}

#[test]
fn delegate_viewing_key_works() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(StealthAddresses::delegate_viewing_key(
            RuntimeOrigin::signed(1),
            5u64,
            0u64,
            Some(1000u64),
            [0u8; 64],
        ));
        System::assert_last_event(
            Event::ViewingKeyDelegated { owner: 1, delegate: 5, valid_until: Some(1000) }.into(),
        );
    });
}

#[test]
fn cannot_delegate_to_self() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            StealthAddresses::delegate_viewing_key(
                RuntimeOrigin::signed(1),
                1u64,
                0u64,
                None,
                [0u8; 64],
            ),
            Error::<Test>::CannotDelegateToSelf
        );
    });
}

// ─── sponsor_gas testovi ──────────────────────────────────────────────────────

#[test]
fn sponsor_gas_below_minimum_fails() {
    new_test_ext().execute_with(|| {
        assert_noop!(
            StealthAddresses::sponsor_gas(RuntimeOrigin::signed(1), 1u128),
            Error::<Test>::DepositBelowMinimum
        );
    });
}

#[test]
fn sponsor_gas_at_minimum_emits_event() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        fund(1, 10_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(RuntimeOrigin::signed(1), 1_000_000u128));
        System::assert_last_event(
            Event::GasSponsorDeposited { sponsor: 1, amount: 1_000_000 }.into(),
        );
    });
}

/// Verifikuj da `sponsor_gas` zaista zaključava sredstva u Balances paletu.
/// Sponzorov slobodan balans se smanjuje, a zaključan se povećava.
#[test]
fn sponsor_gas_actually_holds_balance() {
    new_test_ext().execute_with(|| {
        fund(1, 10_000_000);

        let free_before = Balances::free_balance(1);
        assert_ok!(StealthAddresses::sponsor_gas(RuntimeOrigin::signed(1), 1_000_000u128));
        let free_after = Balances::free_balance(1);

        // Slobodan balans se smanjio za depozit
        assert_eq!(free_before - free_after, 1_000_000u128);

        // Pool evidencija je ažurirana
        assert_eq!(GasSponsorPool::<Test>::get(1), 1_000_000u128);

        // Held balans tačno odgovara depozitu — novac je zaključan, nije otišao
        use frame::traits::fungible::InspectHold;
        let hold_reason =
            RuntimeHoldReason::StealthAddresses(crate::HoldReason::SponsorPool);
        let held = Balances::balance_on_hold(&hold_reason, &1u64);
        assert_eq!(held, 1_000_000u128);
    });
}

/// Sponzor nema dovoljno slobodnih sredstava — hold mora da vrati grešku.
#[test]
fn sponsor_gas_fails_when_insufficient_free_balance() {
    new_test_ext().execute_with(|| {
        // nalog 1 ima 0 tokena
        assert_noop!(
            StealthAddresses::sponsor_gas(RuntimeOrigin::signed(1), 1_000_000u128),
            Error::<Test>::InsufficientSponsorFunds
        );
    });
}

/// Višestruki depoziti od istog sponzora se akumuliraju.
#[test]
fn sponsor_gas_accumulates_multiple_deposits() {
    new_test_ext().execute_with(|| {
        fund(1, 100_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(RuntimeOrigin::signed(1), 1_000_000u128));
        assert_ok!(StealthAddresses::sponsor_gas(RuntimeOrigin::signed(1), 2_000_000u128));
        assert_eq!(GasSponsorPool::<Test>::get(1), 3_000_000u128);
    });
}

// ─── withdraw_from_stealth testovi ────────────────────────────────────────────

/// Kompletan tok povlačenja:
/// 1. Sponzor zaključa sredstva
/// 2. Stealth adresa ima balans
/// 3. Relayer dostavlja validan ECDSA dokaz
/// 4. Palet verifikuje, prenosi fee relayeru, prebacuje stealth balans na destination
#[test]
fn withdraw_from_stealth_works() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);

        let (pair, stealth_addr_bytes, stealth_id) = make_stealth_key(42);
        let destination: u64 = 100;
        let relayer: u64 = 200;
        let sponsor: u64 = 300;
        let stealth_balance: u128 = 50_000_000_000;
        let fee = WithdrawalFee::get();

        // Setup balansa
        fund(stealth_id, stealth_balance);
        fund(sponsor, 10_000_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(
            RuntimeOrigin::signed(sponsor),
            5_000_000_000u128,
        ));

        // Potpiši withdrawal poruku secp256k1 ključem stealth adrese
        let msg = build_withdrawal_msg(&stealth_addr_bytes, destination, None);
        let sig: [u8; 65] = pair.sign(&msg).0;

        let relayer_balance_before = Balances::free_balance(relayer);
        let dest_balance_before = Balances::free_balance(destination);

        assert_ok!(StealthAddresses::withdraw_from_stealth(
            RuntimeOrigin::signed(relayer),
            stealth_addr_bytes,
            destination,
            sig,
            sponsor,
            None,
        ));

        // Stealth adresa je ispražnjena
        assert_eq!(Balances::free_balance(stealth_id), 0);

        // Destination dobio ceo stealth balans
        assert_eq!(Balances::free_balance(destination), dest_balance_before + stealth_balance);

        // Relayer dobio fee
        assert_eq!(Balances::free_balance(relayer), relayer_balance_before + fee);

        // Pool evidencija smanjena za fee
        assert_eq!(GasSponsorPool::<Test>::get(sponsor), 5_000_000_000u128 - fee);
    });
}

/// Lažan (random) potpis mora da vrati InvalidProof.
#[test]
fn withdraw_from_stealth_invalid_signature_fails() {
    new_test_ext().execute_with(|| {
        let (_, stealth_addr_bytes, stealth_id) = make_stealth_key(1);
        fund(stealth_id, 10_000_000_000);
        fund(99, 5_000_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(
            RuntimeOrigin::signed(99),
            1_000_000_000u128,
        ));

        let bad_sig = [0xFFu8; 65];

        assert_noop!(
            StealthAddresses::withdraw_from_stealth(
                RuntimeOrigin::signed(200),
                stealth_addr_bytes,
                100u64,
                bad_sig,
                99u64,
                None,
            ),
            Error::<Test>::InvalidProof
        );
    });
}

/// Potpis je validan ali za drugačiji ključ (različita stealth adresa).
/// Recovered adresa ne poklapa stealth_address → InvalidProof.
#[test]
fn withdraw_from_stealth_wrong_key_fails() {
    new_test_ext().execute_with(|| {
        let (_, stealth_addr_bytes, stealth_id) = make_stealth_key(1);
        let (other_pair, _, _) = make_stealth_key(2); // drugi ključ

        fund(stealth_id, 10_000_000_000);
        fund(99, 5_000_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(
            RuntimeOrigin::signed(99),
            1_000_000_000u128,
        ));

        // Potpisujemo sa POGREŠNIM ključem
        let msg = build_withdrawal_msg(&stealth_addr_bytes, 100u64, None);
        let bad_sig: [u8; 65] = other_pair.sign(&msg).0;

        assert_noop!(
            StealthAddresses::withdraw_from_stealth(
                RuntimeOrigin::signed(200),
                stealth_addr_bytes,
                100u64,
                bad_sig,
                99u64,
                None,
            ),
            Error::<Test>::InvalidProof
        );
    });
}

/// Potpis validan, ali destination u poruci se razlikuje od prosleđenog.
/// Recovered adresa neće odgovarati → InvalidProof.
#[test]
fn withdraw_from_stealth_wrong_destination_in_sig_fails() {
    new_test_ext().execute_with(|| {
        let (pair, stealth_addr_bytes, stealth_id) = make_stealth_key(3);
        fund(stealth_id, 10_000_000_000);
        fund(99, 5_000_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(
            RuntimeOrigin::signed(99),
            1_000_000_000u128,
        ));

        // Potpišemo za destination=100 ali prosleđujemo destination=999
        let msg = build_withdrawal_msg(&stealth_addr_bytes, 100u64, None);
        let sig: [u8; 65] = pair.sign(&msg).0;

        assert_noop!(
            StealthAddresses::withdraw_from_stealth(
                RuntimeOrigin::signed(200),
                stealth_addr_bytes,
                999u64, // ← ne odgovara potpisanom destination-u
                sig,
                99u64,
                None,
            ),
            Error::<Test>::InvalidProof
        );
    });
}

/// Sponzor nema dovoljno u pool-u da pokrije fee → InsufficientSponsorFunds.
#[test]
fn withdraw_from_stealth_insufficient_sponsor_funds_fails() {
    new_test_ext().execute_with(|| {
        let (pair, stealth_addr_bytes, stealth_id) = make_stealth_key(4);
        fund(stealth_id, 10_000_000_000);

        // Sponsor 99 nema nikakav depozit u pool-u
        let msg = build_withdrawal_msg(&stealth_addr_bytes, 100u64, None);
        let sig: [u8; 65] = pair.sign(&msg).0;

        assert_noop!(
            StealthAddresses::withdraw_from_stealth(
                RuntimeOrigin::signed(200),
                stealth_addr_bytes,
                100u64,
                sig,
                99u64, // sponsor bez pool balansa
                None,
            ),
            Error::<Test>::InsufficientSponsorFunds
        );
    });
}

/// Stealth adresa postoji ali ima 0 balansa → ZeroAmount.
#[test]
fn withdraw_from_stealth_zero_balance_fails() {
    new_test_ext().execute_with(|| {
        let (pair, stealth_addr_bytes, _stealth_id) = make_stealth_key(5);

        // Sponzor ima depozit
        fund(99, 5_000_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(
            RuntimeOrigin::signed(99),
            1_000_000_000u128,
        ));

        // Stealth adresa nema tokena
        let msg = build_withdrawal_msg(&stealth_addr_bytes, 100u64, None);
        let sig: [u8; 65] = pair.sign(&msg).0;

        assert_noop!(
            StealthAddresses::withdraw_from_stealth(
                RuntimeOrigin::signed(200),
                stealth_addr_bytes,
                100u64,
                sig,
                99u64,
            None,
        ),
            Error::<Test>::ZeroAmount
        );
    });
}

/// Replay isti withdrawal dva puta — drugi pokušaj pada jer je stealth balans 0.
#[test]
fn withdraw_from_stealth_replay_fails_after_first() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);

        let (pair, stealth_addr_bytes, stealth_id) = make_stealth_key(6);
        fund(stealth_id, 10_000_000_000);
        fund(99, 10_000_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(
            RuntimeOrigin::signed(99),
            5_000_000_000u128,
        ));

        let msg = build_withdrawal_msg(&stealth_addr_bytes, 100u64, None);
        let sig: [u8; 65] = pair.sign(&msg).0;

        // Prvi poziv uspeva
        assert_ok!(StealthAddresses::withdraw_from_stealth(
            RuntimeOrigin::signed(200),
            stealth_addr_bytes,
            100u64,
            sig,
            99u64,
        None,
        ));

        // Isti potpis, isti poziv — stealth balans je sad 0
        assert_noop!(
            StealthAddresses::withdraw_from_stealth(
                RuntimeOrigin::signed(200),
                stealth_addr_bytes,
                100u64,
                sig,
                99u64,
            None,
        ),
            Error::<Test>::ZeroAmount
        );
    });
}
// ─── fungibles (pallet-assets) testovi ───────────────────────────────────────

/// Kompletan tok povlačenja rSDC (pallet-assets) tokena sa stealth adrese.
/// Gas fee plaća sponzor u PAS-u; samo rSDC token se prenosi na destination.
#[test]
fn withdraw_asset_from_stealth_works() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);

        let (pair, stealth_addr_bytes, stealth_id) = make_stealth_key(7);
        let destination: u64 = 100;
        let relayer: u64 = 200;
        let sponsor: u64 = 300;
        let asset_id: u32 = 1;
        let asset_amount: u128 = 1_000_000;
        let fee = WithdrawalFee::get();

        // Sponzor zaključava PAS za gas
        fund(sponsor, 10_000_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(
            RuntimeOrigin::signed(sponsor),
            5_000_000_000u128,
        ));

        // Kreiraj rSDC i mintuj na stealth adresu (stealth nema PAS)
        create_and_mint_asset(asset_id, sponsor, stealth_id, asset_amount);

        let msg = build_withdrawal_msg(&stealth_addr_bytes, destination, Some(asset_id));
        let sig: [u8; 65] = pair.sign(&msg).0;

        let relayer_pas_before = Balances::free_balance(relayer);

        assert_ok!(StealthAddresses::withdraw_from_stealth(
            RuntimeOrigin::signed(relayer),
            stealth_addr_bytes,
            destination,
            sig,
            sponsor,
            Some(asset_id),
        ));

        // Destination dobio rSDC
        assert_eq!(Assets::balance(asset_id, &destination), asset_amount);
        // Stealth adresa ispražnjena
        assert_eq!(Assets::balance(asset_id, &stealth_id), 0u128);
        // Relayer dobio gas fee u PAS-u
        assert_eq!(Balances::free_balance(relayer), relayer_pas_before + fee);
        // Pool smanjen
        assert_eq!(GasSponsorPool::<Test>::get(sponsor), 5_000_000_000u128 - fee);
    });
}

/// Potpis za nativni token (None) se ne može upotrebiti za asset withdrawal (Some).
/// Mismatch u asset_id → mismatch u message hash → InvalidProof.
#[test]
fn withdraw_asset_wrong_asset_id_in_sig_fails() {
    new_test_ext().execute_with(|| {
        let (pair, stealth_addr_bytes, stealth_id) = make_stealth_key(8);
        let asset_id: u32 = 1;

        create_and_mint_asset(asset_id, 99, stealth_id, 1_000_000);
        fund(99, 5_000_000_000);
        assert_ok!(StealthAddresses::sponsor_gas(
            RuntimeOrigin::signed(99),
            1_000_000_000u128,
        ));

        // Potpisan za None, ali šaljemo Some(1)
        let msg = build_withdrawal_msg(&stealth_addr_bytes, 100u64, None);
        let sig: [u8; 65] = pair.sign(&msg).0;

        assert_noop!(
            StealthAddresses::withdraw_from_stealth(
                RuntimeOrigin::signed(200),
                stealth_addr_bytes,
                100u64,
                sig,
                99u64,
                Some(asset_id),
            ),
            Error::<Test>::InvalidProof
        );
    });
}

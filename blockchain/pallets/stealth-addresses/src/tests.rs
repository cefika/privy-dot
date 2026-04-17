use crate::{
    mock::*,
    pallet::{Announcements, Error, Event, StealthMetaAddressRegistry, ViewTagIndex},
};
use frame::testing_prelude::*;

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
fn sponsor_gas_at_minimum_works() {
    new_test_ext().execute_with(|| {
        System::set_block_number(1);
        assert_ok!(StealthAddresses::sponsor_gas(
            RuntimeOrigin::signed(1),
            1_000_000u128,
        ));
        System::assert_last_event(
            Event::GasSponsorDeposited { sponsor: 1, amount: 1_000_000 }.into(),
        );
    });
}
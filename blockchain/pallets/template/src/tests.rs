use crate::{mock::*, pallet::Error, Claims};
use frame::testing_prelude::*;

fn test_hash(n: u64) -> H256 {
	H256::from_low_u64_be(n)
}

#[test]
fn create_claim_works() {
	new_test_ext().execute_with(|| {
		let hash = test_hash(1);
		assert_ok!(ProofOfExistence::create_claim(RuntimeOrigin::signed(1), hash));
		assert!(Claims::<Test>::contains_key(hash));
		let claim = Claims::<Test>::get(hash).unwrap();
		assert_eq!(claim.owner, 1);
	});
}

#[test]
fn create_claim_records_block_number() {
	new_test_ext().execute_with(|| {
		System::set_block_number(5);
		let hash = test_hash(1);
		assert_ok!(ProofOfExistence::create_claim(RuntimeOrigin::signed(1), hash));
		let claim = Claims::<Test>::get(hash).unwrap();
		assert_eq!(claim.block_number, 5);
	});
}

#[test]
fn create_claim_emits_event() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let hash = test_hash(1);
		assert_ok!(ProofOfExistence::create_claim(RuntimeOrigin::signed(1), hash));
		System::assert_last_event(crate::Event::ClaimCreated { who: 1, hash }.into());
	});
}

#[test]
fn create_claim_fails_if_already_claimed() {
	new_test_ext().execute_with(|| {
		let hash = test_hash(1);
		assert_ok!(ProofOfExistence::create_claim(RuntimeOrigin::signed(1), hash));
		assert_noop!(
			ProofOfExistence::create_claim(RuntimeOrigin::signed(2), hash),
			Error::<Test>::AlreadyClaimed,
		);
	});
}

#[test]
fn revoke_claim_works() {
	new_test_ext().execute_with(|| {
		let hash = test_hash(1);
		assert_ok!(ProofOfExistence::create_claim(RuntimeOrigin::signed(1), hash));
		assert_ok!(ProofOfExistence::revoke_claim(RuntimeOrigin::signed(1), hash));
		assert!(!Claims::<Test>::contains_key(hash));
	});
}

#[test]
fn revoke_claim_emits_event() {
	new_test_ext().execute_with(|| {
		System::set_block_number(1);
		let hash = test_hash(1);
		assert_ok!(ProofOfExistence::create_claim(RuntimeOrigin::signed(1), hash));
		assert_ok!(ProofOfExistence::revoke_claim(RuntimeOrigin::signed(1), hash));
		System::assert_last_event(crate::Event::ClaimRevoked { who: 1, hash }.into());
	});
}

#[test]
fn revoke_claim_fails_if_not_owner() {
	new_test_ext().execute_with(|| {
		let hash = test_hash(1);
		assert_ok!(ProofOfExistence::create_claim(RuntimeOrigin::signed(1), hash));
		assert_noop!(
			ProofOfExistence::revoke_claim(RuntimeOrigin::signed(2), hash),
			Error::<Test>::NotClaimOwner,
		);
	});
}

#[test]
fn revoke_claim_fails_if_not_found() {
	new_test_ext().execute_with(|| {
		let hash = test_hash(99);
		assert_noop!(
			ProofOfExistence::revoke_claim(RuntimeOrigin::signed(1), hash),
			Error::<Test>::ClaimNotFound,
		);
	});
}

#[test]
fn unsigned_origin_is_rejected() {
	new_test_ext().execute_with(|| {
		let hash = test_hash(1);
		assert_noop!(
			ProofOfExistence::create_claim(RuntimeOrigin::none(), hash),
			DispatchError::BadOrigin,
		);
		assert_noop!(
			ProofOfExistence::revoke_claim(RuntimeOrigin::none(), hash),
			DispatchError::BadOrigin,
		);
	});
}

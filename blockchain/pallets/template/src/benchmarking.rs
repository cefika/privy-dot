//! Benchmarking setup for pallet-template

use super::*;
use frame::{deps::frame_benchmarking::v2::*, prelude::*};

#[benchmarks]
mod benchmarks {
	use super::*;
	#[cfg(test)]
	use crate::pallet::Pallet as ProofOfExistence;
	use frame_system::RawOrigin;

	#[benchmark]
	fn create_claim() {
		let caller: T::AccountId = whitelisted_caller();
		let hash = H256::repeat_byte(1);
		#[extrinsic_call]
		create_claim(RawOrigin::Signed(caller.clone()), hash);

		assert!(Claims::<T>::contains_key(&hash));
	}

	#[benchmark]
	fn revoke_claim() {
		let caller: T::AccountId = whitelisted_caller();
		let hash = H256::repeat_byte(1);
		Claims::<T>::insert(
			&hash,
			Claim {
				owner: caller.clone(),
				block_number: frame_system::Pallet::<T>::block_number(),
			},
		);
		#[extrinsic_call]
		revoke_claim(RawOrigin::Signed(caller.clone()), hash);

		assert!(!Claims::<T>::contains_key(&hash));
	}

	impl_benchmark_test_suite!(ProofOfExistence, crate::mock::new_test_ext(), crate::mock::Test);
}

//! EVM Precompile most za pallet-stealth-addresses.
//!
//! Registrovan na adresi 0x0000000000000000000000000000100000000000
//! (AddressMatcher::Fixed(0x1000)).

extern crate alloc;

use alloc::vec::Vec;
use codec::Decode;
use core::{marker::PhantomData, num::NonZero};

use polkadot_sdk::{
    frame_support::traits::{
        fungible::Mutate as FungibleMutate,
        tokens::Preservation,
    },
    frame_system::RawOrigin,
    pallet_revive::precompiles::{AddressMatcher, Error, Ext, Precompile},
    sp_core::U256,
    sp_weights::Weight,
};

use pallet_stealth_addresses::{weights::WeightInfo, pallet::BalanceOf};

// ─── Solidity ABI definition ──────────────────────────────────────────────────

polkadot_sdk::pallet_revive::precompiles::alloy::sol! {
    interface IStealthAddresses {
        function registerMetaAddress(
            bytes spendingPubkey,
            bytes viewingPubkey,
            uint32 schemeId
        ) external;

        function announce(
            bytes ephemeralPubkey,
            bytes2 viewTag,
            bytes32 stealthAddress,
            bytes32 metadata
        ) external;

        /// Send the native token (PAS) to an AccountId32 stealth address and immediately
        /// announce it in the same transaction. Payable — ETH value is sent.
        function sendAndAnnounce(
            bytes32 stealthAddress,
            bytes ephemeralPubkey,
            bytes2 viewTag,
            bytes32 metadata
        ) external payable;
    }
}

// ─── Precompile ───────────────────────────────────────────────────────────────

pub struct StealthPrecompile<T>(PhantomData<T>);

impl<T> Precompile for StealthPrecompile<T>
where
    T: polkadot_sdk::pallet_revive::Config + pallet_stealth_addresses::Config,
    <T as polkadot_sdk::frame_system::Config>::RuntimeOrigin:
        From<RawOrigin<<T as polkadot_sdk::frame_system::Config>::AccountId>>,
    <T as polkadot_sdk::frame_system::Config>::AccountId: Decode + Clone,
    <T as pallet_stealth_addresses::Config>::NativeBalance:
        FungibleMutate<<T as polkadot_sdk::frame_system::Config>::AccountId>,
    BalanceOf<T>: TryFrom<u128>,
{
    type T = T;
    type Interface = IStealthAddresses::IStealthAddressesCalls;

    const MATCHER: AddressMatcher = AddressMatcher::Fixed(
        unsafe { NonZero::new_unchecked(0x1000) },
    );

    const HAS_CONTRACT_INFO: bool = false;

    fn call(
        _address: &[u8; 20],
        input: &Self::Interface,
        env: &mut impl Ext<T = Self::T>,
    ) -> Result<Vec<u8>, Error> {
        use IStealthAddresses::IStealthAddressesCalls::*;

        match input {
            registerMetaAddress(call) => {
                let weight: Weight = <T as pallet_stealth_addresses::Config>::WeightInfo
                    ::register_stealth_meta_address();
                env.charge(weight)?;

                let spending_arr: [u8; 33] = call.spendingPubkey.as_ref()
                    .try_into()
                    .map_err(|_| Error::Revert("spendingPubkey must be 33 bytes".into()))?;
                let viewing_arr: [u8; 64] = call.viewingPubkey.as_ref()
                    .try_into()
                    .map_err(|_| Error::Revert("viewingPubkey must be 64 bytes".into()))?;
                
                let caller_account = env.caller().account_id()
                    .map_err(|_| Error::Revert("caller must be a signed account".into()))?
                    .clone();

                pallet_stealth_addresses::Pallet::<T>::register_stealth_meta_address(
                    RawOrigin::Signed(caller_account).into(),
                    spending_arr,
                    viewing_arr,
                    call.schemeId,
                )
                .map_err(Error::from)?;

                Ok(Vec::new())
            }

            announce(call) => {
                let weight: Weight =
                    <T as pallet_stealth_addresses::Config>::WeightInfo::announce();
                env.charge(weight)?;

                let ephemeral_arr: [u8; 64] = call.ephemeralPubkey.as_ref()
                    .try_into()
                    .map_err(|_| Error::Revert("ephemeralPubkey must be 64 bytes".into()))?;

                let stealth_account =
                    <T as polkadot_sdk::frame_system::Config>::AccountId::decode(
                        &mut call.stealthAddress.0.as_ref(),
                    )
                    .map_err(|_| Error::Revert("invalid stealthAddress".into()))?;

                let caller_account = env.caller().account_id()
                    .map_err(|_| Error::Revert("caller must be a signed account".into()))?
                    .clone();

                pallet_stealth_addresses::Pallet::<T>::announce(
                    RawOrigin::Signed(caller_account).into(),
                    ephemeral_arr,
                    call.viewTag.0,
                    stealth_account,
                    call.metadata.0,
                )
                .map_err(Error::from)?;

                Ok(Vec::new())
            }

            sendAndAnnounce(call) => {
                
                let weight: Weight =
                    <T as pallet_stealth_addresses::Config>::WeightInfo::announce();
                env.charge(weight)?;
                
                let value_wei: U256 = env.value_transferred();
                let value_planck_u256 = value_wei / U256::from(1_000_000u64);
                let value_planck_u128: u128 = value_planck_u256
                    .try_into()
                    .map_err(|_| Error::Revert("value overflow".into()))?;
                let native_value = BalanceOf::<T>::try_from(value_planck_u128)
                    .map_err(|_| Error::Revert("balance conversion failed".into()))?;

                let ephemeral_arr: [u8; 64] = call.ephemeralPubkey.as_ref()
                    .try_into()
                    .map_err(|_| Error::Revert("ephemeralPubkey must be 64 bytes".into()))?;

                let stealth_account =
                    <T as polkadot_sdk::frame_system::Config>::AccountId::decode(
                        &mut call.stealthAddress.0.as_ref(),
                    )
                    .map_err(|_| Error::Revert("invalid stealthAddress".into()))?;

                let caller_account = env.caller().account_id()
                    .map_err(|_| Error::Revert("caller must be a signed account".into()))?
                    .clone();
                
                let precompile_account = env.account_id().clone();
                <T as pallet_stealth_addresses::Config>::NativeBalance::transfer(
                    &precompile_account,
                    &stealth_account,
                    native_value,
                    Preservation::Preserve,
                )
                .map_err(|_| Error::Revert("PAS transfer failed".into()))?;
                
                pallet_stealth_addresses::Pallet::<T>::announce(
                    RawOrigin::Signed(caller_account).into(),
                    ephemeral_arr,
                    call.viewTag.0,
                    stealth_account,
                    call.metadata.0,
                )
                .map_err(Error::from)?;

                Ok(Vec::new())
            }
        }
    }
}
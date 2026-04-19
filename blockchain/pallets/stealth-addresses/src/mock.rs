use frame::{
    deps::frame_system::GenesisConfig,
    prelude::*,
    runtime::prelude::*,
    testing_prelude::*,
};
use polkadot_sdk::pallet_balances;

#[frame_construct_runtime]
mod test_runtime {
    #[runtime::runtime]
    #[runtime::derive(
        RuntimeCall,
        RuntimeEvent,
        RuntimeError,
        RuntimeOrigin,
        RuntimeFreezeReason,
        RuntimeHoldReason,
        RuntimeSlashReason,
        RuntimeLockId,
        RuntimeTask,
        RuntimeViewFunction
    )]
    pub struct Test;

    #[runtime::pallet_index(0)]
    pub type System = frame_system;

    #[runtime::pallet_index(1)]
    pub type Balances = pallet_balances;

    #[runtime::pallet_index(2)]
    pub type StealthAddresses = crate;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
    type AccountData = pallet_balances::AccountData<u128>;
    type Nonce = u64;
    type Block = MockBlock<Test>;
    type BlockHashCount = ConstU64<250>;
}

impl pallet_balances::Config for Test {
    type MaxLocks = ConstU32<50>;
    type Balance = u128;
    type RuntimeEvent = RuntimeEvent;
    type DustRemoval = ();
    type ExistentialDeposit = ConstU128<1>;
    type AccountStore = System;
    type WeightInfo = ();
    type MaxReserves = ConstU32<50>;
    type ReserveIdentifier = [u8; 8];
    type RuntimeHoldReason = RuntimeHoldReason;
    type RuntimeFreezeReason = RuntimeFreezeReason;
    type FreezeIdentifier = RuntimeFreezeReason;
    type MaxFreezes = ConstU32<0>;
    type DoneSlashHandler = ();
}

parameter_types! {
    /// Naknada relayeru pri povlačenju: 1_000_000_000 planck-ova = 0.001 DOT ekvivalent.
    pub const WithdrawalFee: u128 = 1_000_000_000;
}

impl crate::Config for Test {
    type MaxAnnouncementsPerViewTag = ConstU32<10_000>;
    type MaxDelegationsPerUser = ConstU32<16>;
    type MinSponsorDeposit = ConstU128<1_000_000>;
    type WithdrawalFee = WithdrawalFee;
    type NativeBalance = Balances;
    type RuntimeHoldReason = RuntimeHoldReason;
    /// () implementira SendXcm kao no-op — dovoljno za unit testove koji ne testiraju XCM.
    type XcmSender = ();
    type WeightInfo = ();
}

pub fn new_test_ext() -> TestState {
    GenesisConfig::<Test>::default().build_storage().unwrap().into()
}

/// Postavi slobodan balans za nalog — koristi privilegovani `force_set_balance`.
/// Mora se zvati unutar `new_test_ext().execute_with(|| { ... })`.
pub fn fund(who: u64, amount: u128) {
    Balances::force_set_balance(RuntimeOrigin::root(), who, amount)
        .expect("force_set_balance failed in test setup");
}
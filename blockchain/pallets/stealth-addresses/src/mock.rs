use frame::{
    deps::frame_system::GenesisConfig,
    prelude::*,
    runtime::prelude::*,
    testing_prelude::*,
};

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
    pub type StealthAddresses = crate;
}

#[derive_impl(frame_system::config_preludes::TestDefaultConfig)]
impl frame_system::Config for Test {
    type Nonce = u64;
    type Block = MockBlock<Test>;
    type BlockHashCount = ConstU64<250>;
}

impl crate::Config for Test {
    type MaxAnnouncementsPerViewTag = ConstU32<10_000>;
    type MaxDelegationsPerUser = ConstU32<16>;
    type MinSponsorDeposit = ConstU128<1_000_000>;
    type WeightInfo = ();
}

pub fn new_test_ext() -> TestState {
    GenesisConfig::<Test>::default().build_storage().unwrap().into()
}
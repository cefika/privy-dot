use frame::{
    deps::frame_system::GenesisConfig,
    prelude::*,
    runtime::prelude::*,
    testing_prelude::*,
    traits::AsEnsureOriginWithArg,
};
use polkadot_sdk::{pallet_assets, pallet_balances};

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

    #[runtime::pallet_index(3)]
    pub type Assets = pallet_assets;
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

impl pallet_assets::Config for Test {
    type RuntimeEvent = RuntimeEvent;
    type Balance = u128;
    type RemoveItemsLimit = ConstU32<1_000>;
    type AssetId = u32;
    type AssetIdParameter = u32;
    type Currency = Balances;
    type CreateOrigin = AsEnsureOriginWithArg<EnsureSigned<u64>>;
    type ForceOrigin = EnsureRoot<u64>;
    type AssetDeposit = ConstU128<1>;
    type AssetAccountDeposit = ConstU128<1>;
    type MetadataDepositBase = ConstU128<0>;
    type MetadataDepositPerByte = ConstU128<0>;
    type ApprovalDeposit = ConstU128<0>;
    type StringLimit = ConstU32<50>;
    type Freezer = ();
    type Extra = ();
    type CallbackHandle = ();
    type WeightInfo = ();
    type ReserveData = ();
    type Holder = ();
    #[cfg(feature = "runtime-benchmarks")]
    type BenchmarkHelper = ();
}

parameter_types! {
    /// Relayer fee on withdrawal: 1_000_000_000 planck = 0.001 DOT equivalent.
    pub const WithdrawalFee: u128 = 1_000_000_000;
}

impl crate::Config for Test {
    type MaxAnnouncementsPerViewTag = ConstU32<10_000>;
    type MaxDelegationsPerUser = ConstU32<16>;
    type MinSponsorDeposit = ConstU128<1_000_000>;
    type WithdrawalFee = WithdrawalFee;
    type NativeBalance = Balances;
    type RuntimeHoldReason = RuntimeHoldReason;
    type AssetId = u32;
    type Assets = Assets;
    /// () implements SendXcm as a no-op — sufficient for unit tests that do not test XCM.
    type XcmSender = ();
    type WeightInfo = ();
}

pub fn new_test_ext() -> TestState {
    GenesisConfig::<Test>::default().build_storage().unwrap().into()
}

/// Set the free balance for an account — uses the privileged `force_set_balance`.
/// Must be called inside `new_test_ext().execute_with(|| { ... })`.
pub fn fund(who: u64, amount: u128) {
    Balances::force_set_balance(RuntimeOrigin::root(), who, amount)
        .expect("force_set_balance failed in test setup");
}

/// Create a pallet-assets token and mint it to an account.
/// `asset_id` — token ID (e.g. 1 for rSDC)
/// `owner`    — who controls the asset
/// `to`       — who receives the minted tokens
/// `amount`   — how many tokens to mint
pub fn create_and_mint_asset(asset_id: u32, owner: u64, to: u64, amount: u128) {
    Assets::force_create(RuntimeOrigin::root(), asset_id, owner, true, 1)
        .expect("force_create failed");
    Assets::mint(RuntimeOrigin::signed(owner), asset_id, to, amount)
        .expect("mint failed");
}
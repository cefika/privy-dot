use crate::{Block, RuntimeApiImpl, VERSION};
use polkadot_sdk::{
	sp_api::{ApiError, CallApiAt, CallApiAtParams},
	sp_externalities::Extensions,
	sp_runtime::traits::{Block as BlockT, HashingFor},
	sp_state_machine::InMemoryBackend,
	sp_statement_store::runtime_api::ValidateStatement,
	sp_version::RuntimeVersion,
};

struct DummyCallApi;

impl CallApiAt<Block> for DummyCallApi {
	type StateBackend = InMemoryBackend<HashingFor<Block>>;

	fn call_api_at(&self, _params: CallApiAtParams<Block>) -> Result<Vec<u8>, ApiError> {
		unreachable!("compile-time api assertion should not execute runtime calls")
	}

	fn runtime_version_at(
		&self,
		_at_hash: <Block as BlockT>::Hash,
	) -> Result<RuntimeVersion, ApiError> {
		Ok(VERSION)
	}

	fn state_at(&self, _at: <Block as BlockT>::Hash) -> Result<Self::StateBackend, ApiError> {
		Ok(Default::default())
	}

	fn initialize_extensions(
		&self,
		_at: <Block as BlockT>::Hash,
		_extensions: &mut Extensions,
	) -> Result<(), ApiError> {
		Ok(())
	}
}

#[test]
fn runtime_implements_statement_validation_api() {
	fn assert_validate_statement<T: ValidateStatement<Block>>() {}

	assert_validate_statement::<RuntimeApiImpl<Block, DummyCallApi>>();
}

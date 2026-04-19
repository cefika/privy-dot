//! Težine operacija za pallet-stealth-addresses.
//!
//! U produkciji se ovo generiše automatski putem `frame_benchmarking`.
//! Za sada su placeholder vrednosti — dovoljne za development i testnet.

use frame::prelude::*;

pub trait WeightInfo {
    fn register_stealth_meta_address() -> Weight;
    fn announce() -> Weight;
    fn sponsor_gas() -> Weight;
    fn delegate_viewing_key() -> Weight;
    fn send_stealth_xcm() -> Weight;
    fn withdraw_from_stealth() -> Weight;
}

/// Placeholder implementacija — koristiti za development i testnet.
/// Pre mainnet deploya pokrenuti benchmarke i zameniti stvarnim vrednostima.
impl WeightInfo for () {
    fn register_stealth_meta_address() -> Weight {
        Weight::from_parts(20_000_000, 4_096)
    }
    fn announce() -> Weight {
        Weight::from_parts(30_000_000, 4_096)
    }
    fn sponsor_gas() -> Weight {
        Weight::from_parts(15_000_000, 2_048)
    }
    fn delegate_viewing_key() -> Weight {
        Weight::from_parts(20_000_000, 4_096)
    }
    fn send_stealth_xcm() -> Weight {
        Weight::from_parts(100_000_000, 8_192)
    }
    fn withdraw_from_stealth() -> Weight {
        // ECDSA recovery (~3ms) + 2x balance transfer + hold release
        Weight::from_parts(200_000_000, 8_192)
    }
}
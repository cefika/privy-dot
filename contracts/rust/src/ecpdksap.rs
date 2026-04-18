//! ECPDKSAP — pvm-contract-macros approach
//!
//! Registry (registerMetaAddress / updateMetaAddress / resolve) je zakomentarisan.
//! ID format konvencija kada se odkomentariše: "alice.dot", "bob.dot" itd.

#![cfg_attr(not(feature = "abi-gen"), no_main, no_std)]

// Uncomment when registry is enabled:
// extern crate alloc;
// use alloc::{string::String, vec::Vec};

use pallet_revive_uapi::{CallFlags, HostFnImpl as api};

#[pvm_contract_macros::contract("ECPDKSAP.sol", allocator = "pico")]
mod ecpdksap {
    use super::*;
    use pvm_contract_types::Address;
    use ruint::aliases::U256;

    const SCHEME_ID: u64 = 2901;

    /// keccak256("Announcement(uint256,address,address,bytes,bytes)")
    const ANNOUNCEMENT_SIG: [u8; 32] = [
        0x5f, 0x0e, 0xab, 0x80, 0x57, 0x63, 0x0b, 0xa7,
        0x67, 0x6c, 0x49, 0xb4, 0xf2, 0x1a, 0x02, 0x31,
        0x41, 0x4e, 0x79, 0x47, 0x45, 0x95, 0xbe, 0x8e,
        0x4c, 0x43, 0x2f, 0xbf, 0x6b, 0xf0, 0xf4, 0xe7,
    ];

    // ── Constructor ───────────────────────────────────────────────────────────

    #[pvm_contract_macros::constructor]
    pub fn new() -> Result<(), pvm_contract_types::EmptyError> {
        Ok(())
    }

    // ── Registry (zakomentarisan) ─────────────────────────────────────────────
    // ID konvencija: "alice.dot", "bob.dot" — samo string, kontrakt ne proverava format.
    // Odkomentariši kada zatreba on-chain meta address lookup.
    //
    // #[pvm_contract_macros::method]
    // pub fn register_meta_address(id: String, meta_address: Vec<u8>) {
    //     store_bytes(&meta_key(id.as_bytes()), &meta_address);
    // }
    //
    // #[pvm_contract_macros::method]
    // pub fn update_meta_address(id: String, meta_address: Vec<u8>) {
    //     store_bytes(&meta_key(id.as_bytes()), &meta_address);
    // }
    //
    // #[pvm_contract_macros::method]
    // pub fn resolve(id: String) -> Vec<u8> {
    //     load_bytes(&meta_key(id.as_bytes()))
    // }

    // ── Send ──────────────────────────────────────────────────────────────────

    /// Emituje Announcement event i prosleđuje ETH na stealth adresu.
    /// ETH forwarding i event emisija su i dalje ručni — framework to ne pokriva.
    #[pvm_contract_macros::method]
    pub fn send_eth_via_proxy(stealth_address: Address, r: pvm_contract_types::Bytes, view_tag: pvm_contract_types::Bytes) {
        let stealth: [u8; 20] = stealth_address.into();
        emit_announcement(&stealth, &r.0, &view_tag.0);
        forward_value(&stealth);
    }

    // ── View ──────────────────────────────────────────────────────────────────

    /// Vraća scheme ID (2901). Renamed iz ECPDKSAP_SCHEME_ID → ecpdksapSchemeId
    /// da prati camelCase konvenciju frameworka.
    #[pvm_contract_macros::method]
    pub fn ecpdksap_scheme_id() -> U256 {
        U256::from(SCHEME_ID)
    }

    #[pvm_contract_macros::fallback]
    pub fn fallback() -> Result<(), pvm_contract_types::EmptyError> {
        Ok(())
    }

    // ── Storage helpers (zakomentarisano — koristi se samo za registry) ──────
    //
    // fn meta_key(id: &[u8]) -> [u8; 32] { ... }
    // fn store_bytes(base_key: &[u8; 32], data: &[u8]) { ... }
    // fn load_bytes(base_key: &[u8; 32]) -> Vec<u8> { ... }
    //
    // Odkomentariši zajedno sa registry metodama kada zatreba.

    // ── Event helpers ─────────────────────────────────────────────────────────

    fn emit_announcement(stealth: &[u8; 20], r: &[u8], view_tag: &[u8]) {
        let mut scheme_topic = [0u8; 32];
        scheme_topic[24..32].copy_from_slice(&SCHEME_ID.to_be_bytes());

        let mut stealth_topic = [0u8; 32];
        stealth_topic[12..32].copy_from_slice(stealth);

        let mut caller_raw = [0u8; 20];
        api::caller(&mut caller_raw);
        let mut caller_topic = [0u8; 32];
        caller_topic[12..32].copy_from_slice(&caller_raw);

        let topics = [ANNOUNCEMENT_SIG, scheme_topic, stealth_topic, caller_topic];

        // abi.encode(bytes R, bytes viewTag)
        let offset_r: usize = 0x40;
        let offset_vt = offset_r + 0x20 + pad32(r.len());
        let data_len = offset_vt + 0x20 + pad32(view_tag.len());

        let mut data = [0u8; 672];
        write_u256(&mut data, 0, offset_r);
        write_u256(&mut data, 32, offset_vt);
        write_u256(&mut data, offset_r, r.len());
        data[offset_r + 32..offset_r + 32 + r.len()].copy_from_slice(r);
        write_u256(&mut data, offset_vt, view_tag.len());
        data[offset_vt + 32..offset_vt + 32 + view_tag.len()].copy_from_slice(view_tag);

        api::deposit_event(&topics, &data[..data_len]);
    }

    fn forward_value(stealth: &[u8; 20]) {
        let mut value = [0u8; 32];
        api::value_transferred(&mut value);
        if value == [0u8; 32] {
            return;
        }
        let _ = api::call(
            CallFlags::empty(),
            stealth,
            u64::MAX,
            u64::MAX,
            &[0u8; 32],
            &value,
            &[],
            None,
        );
    }

    #[inline]
    fn pad32(n: usize) -> usize {
        (n + 31) & !31
    }

    fn write_u256(buf: &mut [u8; 672], offset: usize, val: usize) {
        buf[offset + 24..offset + 32].copy_from_slice(&(val as u64).to_be_bytes());
    }
}
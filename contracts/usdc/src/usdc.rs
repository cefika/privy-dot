#![no_main]
#![no_std]

use alloy_core::{
    primitives::{Address, U256},
    sol,
    sol_types::{SolCall, SolError, SolEvent},
};
use pallet_revive_uapi::{HostFn, HostFnImpl as api, ReturnFlags, StorageFlags};

extern crate alloc;
use alloc::vec;

sol!("USDC.sol");

#[global_allocator]
static mut ALLOC: picoalloc::Mutex<picoalloc::Allocator<picoalloc::ArrayPointer<1024>>> = {
    static mut ARRAY: picoalloc::Array<1024> = picoalloc::Array([0u8; 1024]);

    picoalloc::Mutex::new(picoalloc::Allocator::new(unsafe {
        picoalloc::ArrayPointer::new(&raw mut ARRAY)
    }))
};

#[panic_handler]
fn panic(_info: &core::panic::PanicInfo) -> ! {
    unsafe {
        core::arch::asm!("unimp");
        core::hint::unreachable_unchecked();
    }
}

/// Konstruktor — poziva se jednom pri deployu.
#[polkavm_derive::polkavm_export]
pub extern "C" fn deploy() {}

/// Glavni entry point — dispatcher po ABI selektoru.
#[polkavm_derive::polkavm_export]
pub extern "C" fn call() {
    let call_data_len = api::call_data_size();
    let mut call_data = vec![0u8; call_data_len as usize];
    api::call_data_copy(&mut call_data, 0);

    let selector: [u8; 4] = call_data[0..4].try_into().unwrap();

    match selector {
        USDC::balanceOfCall::SELECTOR => {
            let decoded = USDC::balanceOfCall::abi_decode(&call_data, true)
                .expect("Failed to decode balanceOf");
            let balance = get_balance(&decoded.account.into_array());
            api::return_value(ReturnFlags::empty(), &balance.to_be_bytes::<32>());
        }

        USDC::mintCall::SELECTOR => {
            let decoded = USDC::mintCall::abi_decode(&call_data, true)
                .expect("Failed to decode mint");

            let new_balance = get_balance(&decoded.to.into_array()).saturating_add(decoded.amount);
            set_balance(&decoded.to.into_array(), new_balance);

            let new_supply = get_total_supply().saturating_add(decoded.amount);
            set_total_supply(new_supply);

            emit_transfer(Address::ZERO, decoded.to, decoded.amount);
        }

        USDC::totalSupplyCall::SELECTOR => {
            let supply = get_total_supply();
            api::return_value(ReturnFlags::empty(), &supply.to_be_bytes::<32>());
        }

        USDC::transferCall::SELECTOR => {
            let decoded = USDC::transferCall::abi_decode(&call_data, true)
                .expect("Failed to decode transfer");

            let caller = get_caller();
            let sender_balance = get_balance(&caller);

            if sender_balance < decoded.amount {
                revert_insufficient_balance();
            }

            set_balance(&caller, sender_balance - decoded.amount);
            let recipient_balance = get_balance(&decoded.to.into_array());
            set_balance(&decoded.to.into_array(), recipient_balance + decoded.amount);

            emit_transfer(Address::from(caller), decoded.to, decoded.amount);
        }

        _ => panic!("Unknown selector"),
    }
}

// ── Storage helpers ───────────────────────────────────────────────────────────

/// Slot 0 — totalSupply
fn total_supply_key() -> [u8; 32] {
    [0u8; 32]
}

/// Slot 1 — balances[address] — keccak256(pad32(addr) ++ pad32(1))
fn balance_key(addr: &[u8; 20]) -> [u8; 32] {
    let mut input = [0u8; 64];
    input[12..32].copy_from_slice(addr);
    input[63] = 1;
    let mut key = [0u8; 32];
    api::hash_keccak_256(&input, &mut key);
    key
}

fn get_total_supply() -> U256 {
    let key = total_supply_key();
    let mut buf = vec![0u8; 32];
    let mut out = buf.as_mut_slice();
    match api::get_storage(StorageFlags::empty(), &key, &mut out) {
        Ok(_) => U256::from_be_bytes::<32>(out[0..32].try_into().unwrap()),
        Err(_) => U256::ZERO,
    }
}

fn set_total_supply(amount: U256) {
    api::set_storage(StorageFlags::empty(), &total_supply_key(), &amount.to_be_bytes::<32>());
}

fn get_balance(addr: &[u8; 20]) -> U256 {
    let key = balance_key(addr);
    let mut buf = vec![0u8; 32];
    let mut out = buf.as_mut_slice();
    match api::get_storage(StorageFlags::empty(), &key, &mut out) {
        Ok(_) => U256::from_be_bytes::<32>(out[0..32].try_into().unwrap()),
        Err(_) => U256::ZERO,
    }
}

fn set_balance(addr: &[u8; 20], amount: U256) {
    api::set_storage(StorageFlags::empty(), &balance_key(addr), &amount.to_be_bytes::<32>());
}

fn emit_transfer(from: Address, to: Address, value: U256) {
    let event = USDC::Transfer { from, to, value };
    let topics = [
        USDC::Transfer::SIGNATURE_HASH.0,
        event.from.into_word().0,
        event.to.into_word().0,
    ];
    api::deposit_event(&topics, &event.value.to_be_bytes::<32>());
}

fn revert_insufficient_balance() -> ! {
    let encoded = <USDC::InsufficientBalance as SolError>::abi_encode(&USDC::InsufficientBalance {});
    api::return_value(ReturnFlags::REVERT, &encoded);
}

fn get_caller() -> [u8; 20] {
    let mut caller = [0u8; 20];
    api::caller(&mut caller);
    caller
}
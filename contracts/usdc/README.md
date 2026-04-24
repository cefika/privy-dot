# contracts/usdc — Mock USDC PolkaVM Contract

Mock ERC-20 token (USDC) implemented as a PolkaVM contract. Used in local dev and testnet for payroll and multi-token stealth transfer testing.

## Interface

Standard ERC-20:

| Method | Description |
|---|---|
| `balanceOf(address)` | Returns token balance |
| `transfer(address to, uint256 amount)` | Transfer tokens |
| `transferFrom(address from, address to, uint256 amount)` | Transfer on behalf |
| `approve(address spender, uint256 amount)` | Set allowance |
| `allowance(address owner, address spender)` | Read allowance |
| `mint(address to, uint256 amount)` | Mint tokens (unrestricted — dev only) |
| `totalSupply()` | Total supply |

Event: `Transfer(address indexed from, address indexed to, uint256 value)`

## Build

Same two-stage build as the stealth contract. Host compilation fails on Mac — expected.

```bash
cd contracts/usdc
cargo build --release
```

Output artifact: `target/usdc.release.polkavm`

## Notes

- `mint()` has no access control — anyone can mint. This is intentional for local dev.
- Uses raw `pallet-revive-uapi` (no macro framework), with `alloy-core` for ABI decoding.
- Heap: 1024B picoalloc array, sufficient for ERC-20 operations.
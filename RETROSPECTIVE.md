# PBP Project Retrospective

**Your name:** Stefan Mitrovic
**Project name:** PrivyDot
**Repo URL:** https://github.com/cefika/privy-dot
**Path chosen:** Pallet + React web app

---

## What I built

PrivyDot is a stealth address protocol built on Polkadot parachains. Stealth addresses let a sender transfer funds to a one-time on-chain address that only the intended recipient can discover, using an ECDH key exchange over two elliptic curves (BN254 + secp256k1). The sender never needs the recipient's real wallet address; instead they use a published meta-address, generate a fresh stealth address per transaction, and leave an encrypted hint on-chain. The recipient scans the chain, derives the same address locally, and claims the funds using their private key. No one else can link the stealth address back to the recipient.

The protocol is built for anyone who needs financial privacy on a public blockchain: individuals making personal payments, companies running payroll without exposing salaries on-chain, or NGOs receiving donations privately. At the same time, a government or compliance body can be given a view key that lets them audit all incoming transactions for a recipient, without being able to spend anything. Privacy and accountability co-exist in the same design.

Polkadot was a deliberate choice. XCM lets funds move between parachains natively, no bridge, no wrapped token, no third-party trust. A user on Para 1000 can send to a stealth address on Para 2000 in a single extrinsic. Gas fees are low enough that sponsoring withdrawals on behalf of stealth addresses is economically viable, which is why the pallet includes a built-in gas sponsor pool.

---

## Why I picked this path

I explored three contract approaches before settling on a pallet. I started with Solidity via the EVM compatibility layer, then moved to Rust smart contracts on PVM so both compiled and ran, which was not guaranteed since PVM is still in testing on Polkadot. But contracts alone couldn't do what I needed: there's no native XCM from a contract, and implementing a gas sponsor pool at the contract level is either impossible or requires too many workarounds. So I moved the core logic into a custom Substrate pallet, which gave me full control over storage, native XCM dispatch, and the ability to build the sponsor pool as a first-class pallet feature. The contracts stayed in the repo as a proof of concept.

For the frontend I chose React because the project needed a browser-based demo and the WASM cryptography module (stealth address derivation compiled from Go) loads naturally in a browser context, and React made it easy to wire up Polkadot.js API alongside it.

This was the riskiest path on the matrix. PVM contracts on Polkadot are not production-ready, I knew going in that I might hit a wall. I hit several, but they were all solvable. The pallet route added significant complexity but it was the only way to build the full protocol the way it was designed.

---

## What worked

Surprisingly, most of the stack worked the way the docs said it would. Writing a custom pallet in FRAME was the smoothest part and the macro system handles a lot of boilerplate, and once you understand how `#[pallet::storage]`, `#[pallet::call]`, and `#[pallet::event]` fit together, adding new functionality is fast. The storage query API on the JS side matched exactly what I defined in Rust, which made wiring the frontend straightforward.

Zombienet was genuinely easy to set up. Getting two parachains running locally with a relay chain was quick, and the config format is readable enough that tweaking it didn't require much guesswork.

XCM worked on the first real attempt once I understood the message format. The `reserveTransferAssets` flow between parachains was well-documented in the Polkadot SDK examples, and the actual delivery to the stealth address on Para 2000 worked exactly as expected.

The Go → WASM pipeline for the cryptography module compiled without issues and loaded cleanly in the browser. Hosting it on GitHub Pages and fetching it at runtime was a clean solution that I'd use again.

Polkadot.js API was reliable throughout: submitting extrinsics, reading storage, decoding events. It did everything I needed without surprises.

---

## What broke

**Problem 1: WASM size vs. Bulletin upload limits**

Go compiles its entire runtime into the binary and my cryptography module came out at 5.2 MB. Bulletin splits file uploads into 2 MB chunks, which means 4 chunks across 2 batches, and the WebSocket connection dropped between batches every single time. No error message, just a silent failure. The fix was to host the WASM file on GitHub Pages and have the app fetch it at runtime only the 1.6 MB app shell gets deployed to Bulletin. It works, but it's an awkward split that shouldn't be necessary.

**Problem 2: `pallet-multisig` BlockNumberProvider, zero documentation :(**

`pallet-multisig` has a required associated type in its `Config` trait called `BlockNumberProvider`. It was added in a newer version of the Polkadot SDK to make the block number source configurable and useful for on-demand parachains, but a breaking change with no migration guide, no changelog entry I could find, and no example in the official docs. The runtime compiled fine; the failure only showed up at runtime when calling `asMulti`. The fix is one line: `type BlockNumberProvider = System;`. I found it by reading the pallet source directly and there is a comment there, but it's inside the source code, not anywhere a developer would look first.

---

## What I'd do differently

Maybe I would pick a different project topic. Privacy and cryptography are genuinely interesting to me, but the audience often finds it hard to grasp, both the use case and the low-level mechanics behind it. That's not a criticism of the mentors, it's just the reality of presenting something ZK and cryptography-heavy to a general audience. If I started over, I'd build something where the value is immediately obvious, and save the stealth address work for a context where the room already understands the cryptography.

On the deployment side, I wasted time trying to get the WASM app running on Bulletin when GitHub Pages was always the simpler answer. I'd skip Bulletin entirely from the start and deploy to GitHub Pages on day one.

One thing outside my control: I got sick before the final presentation and couldn't present live. I recorded the full demo in advance instead. :(

---

## Stack feedback for Parity

The biggest gap is documentation for PVM and Rust contracts. When I started, there was almost nothing explaining how Rust contracts actually work on the revive/PVM stack: no end-to-end example, no explanation of the execution model, no guide on how the EVM compatibility layer maps to Substrate. I ended up reaching out directly to Leo, one of the engineers working on the product, just to get basic clarity. That shouldn't be necessary. A few simple worked examples: a contract that deploys, reads storage, and emits an event and would have saved days.

On the positive side: FRAME macros, Zombienet, and XCM are genuinely good. The macro system makes pallet development fast once you understand the pattern, Zombienet makes local multi-chain testing accessible, and XCM is powerful in a way that no other ecosystem can match right now. These should not change.

The one thing I'd most want fixed: changelog entries and migration notes for breaking changes in pallet configs. The `BlockNumberProvider` issue in `pallet-multisig` cost me real time and the information existed it was just buried in the source code instead of anywhere a developer would look.

---

## Links

- **Bug reports filed:** N/A
- **PRs submitted to stack repos:** N/A
- **Pitch slides / presentation:** see prezentacija.mp4 in repo root
- **Demo video (if any):** see prezentacija.mp4 in repo root
- **Live deployment (if any):** https://cefika.github.io/privy-dot/
- **Anything else worth sharing:**
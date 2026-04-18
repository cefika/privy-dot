// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

// Registry (registerMetaAddress / updateMetaAddress / resolve) je zakomentarisan u Rust kodu.
// Kada se odkomentariše, dodati ovde:
//   function registerMetaAddress(string calldata id, bytes calldata metaAddress) external payable;
//   function updateMetaAddress(string calldata id, bytes calldata metaAddress) external;
//   function resolve(string calldata id) external view returns (bytes memory);

interface ECPDKSAP {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function sendEthViaProxy(address payable stealthAddress, bytes calldata R, bytes calldata viewTag) external payable;
    function ecpdksapSchemeId() external view returns (uint256);
}
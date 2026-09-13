// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Generated from perun-eth-backend v0.6.0 bindings/adjudicator/Adjudicator.go ABI.
// Field order/types are the pinned official Perun ABI, including cross-chain fields.
library PerunTypes {
    struct Participant {
        address ethAddress;
        bytes ccAddress;
    }
    struct Params {
        uint256 challengeDuration;
        uint256 nonce;
        Participant[] participants;
        address app;
        bool ledgerChannel;
        bool virtualChannel;
    }
    struct Asset {
        uint256 chainID;
        address ethHolder;
        bytes ccHolder;
    }
    struct SubAlloc {
        bytes32 ID;
        uint256[] balances;
        uint16[] indexMap;
    }
    struct Allocation {
        Asset[] assets;
        uint256[] backends;
        uint256[][] balances;
        SubAlloc[] locked;
    }
    struct State {
        bytes32 channelID;
        uint64 version;
        Allocation outcome;
        bytes appData;
        bool isFinal;
    }
}

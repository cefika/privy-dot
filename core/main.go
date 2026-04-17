//go:build js && wasm

package main

import (
	"privy-core/recipient"
	"privy-core/sender"
	"privy-core/utils"
	"syscall/js"
)

func main() {
	c := make(chan struct{}, 0)

	js.Global().Set("new_meta", js.FuncOf(newMeta))
	js.Global().Set("get_meta", js.FuncOf(getMeta))
	js.Global().Set("send", js.FuncOf(send))
	js.Global().Set("scan", js.FuncOf(scan))
	// debugging options
	js.Global().Set("dbg_isValidBN254Point", js.FuncOf(isValidBN254Point))
	js.Global().Set("dbg_isValidSECP256k1Point", js.FuncOf(isValidSECP256k1Point))

	<-c
}

func newMeta(in js.Value, args []js.Value) interface{} {
	return recipient.NewMeta()
}

func getMeta(in js.Value, args []js.Value) interface{} {
	return recipient.GetMeta(args[0].String())
}

func send(in js.Value, args []js.Value) interface{} {
	return sender.Send(args[0].String())
}

func scan(in js.Value, args []js.Value) interface{} {
	return recipient.Scan(args[0].String())
}

func isValidBN254Point(in js.Value, args []js.Value) interface{} {
	return utils.IsValidBN254Point(args[0].String())
}
func isValidSECP256k1Point(in js.Value, args []js.Value) interface{} {
	return utils.IsValidSECP256k1Point(args[0].String())
}
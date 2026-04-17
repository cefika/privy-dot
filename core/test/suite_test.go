package test

import (
	"privy-core/recipient"
	"privy-core/sender"
	"privy-core/utils"
	"encoding/json"
	"fmt"
	"testing"
)

func TestIsValidBN254Point (t *testing.T) {

	_, V, _ := utils.BN254_GenG1KeyPair()
	Vstr := utils.PackXY(V.X.String(), V.Y.String())

	if(!utils.IsValidBN254Point(Vstr)) { panic("ERR: Invalid point"); }
}

func TestIsInValidBN254Point (t *testing.T) {

	Vstr := utils.PackXY("test1", "22")
	if(utils.IsValidBN254Point(Vstr)) { panic("ERR: Valid point"); }
}

func TestIsValidSECP256k1Point(t * testing.T) {

	_, K := utils.SECP256k_Gen1G1KeyPair()
	Kstr := utils.PackXY(K.X.String(), K.Y.String())
	if(!utils.IsValidSECP256k1Point(Kstr)) { panic("ERR: Invalid point"); }
}

func TestIsInValidSECP256k1Point(t * testing.T) {
	Kstr := "invalid.123"
	if(utils.IsValidSECP256k1Point(Kstr)) { panic("ERR: Valid point"); }
}

func TestSend(t *testing.T) {

	_, K := utils.SECP256k_Gen1G1KeyPair()
	_, V, _ := utils.BN254_GenG1KeyPair()

	output := sender.Send(`{"K":"` + utils.PackXY(K.X.String(), K.Y.String()) + `","V":"` + utils.PackXY(V.X.String(), V.Y.String()) + `"}`)

	t.Log(output)
}

func TestE2E(t *testing.T) {

	k, K := utils.SECP256k_Gen1G1KeyPair()
	v, V, _ := utils.BN254_GenG1KeyPair()

	var sendOutput sender.SenderOutputData
	sendJsonOutput := sender.Send(`{"K":"` + utils.PackXY(K.X.String(), K.Y.String()) + `","V":"` + utils.PackXY(V.X.String(), V.Y.String()) + `"}`)

	json.Unmarshal([]byte(sendJsonOutput), &sendOutput)

	fmt.Println("sendOutput", sendOutput)

	var recipientInputData recipient.RecipientInputData
	recipientInputData.PK_k = k.Text(16)
	recipientInputData.PK_v = v.Text(16)
	recipientInputData.Rs = []string{sendOutput.R}
	recipientInputData.ViewTags = []string{sendOutput.ViewTag}

	tmp, _ := json.Marshal(recipientInputData)
	receiveOutput := recipient.Scan(string(tmp))

	fmt.Println("receiveOutput", receiveOutput)
}



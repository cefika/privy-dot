package recipient

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"

	BN254 "github.com/consensys/gnark-crypto/ecc/bn254"
	BN254_fr "github.com/consensys/gnark-crypto/ecc/bn254/fr"
	SECP256K1 "github.com/consensys/gnark-crypto/ecc/secp256k1"
	SECP256K1_fr "github.com/consensys/gnark-crypto/ecc/secp256k1/fr"

	"privy-core/utils"
)

func NewMeta() (outputJsonString string) {

	k, K := utils.SECP256k_Gen1G1KeyPair()
	v, V, err := utils.BN254_GenG1KeyPair()

	if err != nil {
		log.Printf("error generating K and V: %v", err)
		panic(fmt.Errorf("error generating K and V: %v", err))
	}

	var recipientNewMeta RecipientNewMeta
	recipientNewMeta.PK_k = k.Text(16)
	recipientNewMeta.PK_v = v.Text(16)
	recipientNewMeta.K = utils.PackXY(K.X.String(), K.Y.String())
	recipientNewMeta.V = utils.PackXY(V.X.String(), V.Y.String())

	tmp, err := json.Marshal(recipientNewMeta)

	if err != nil {
		log.Printf("error marshalling new recipient meta: %v", err)
		panic(fmt.Errorf("error marshalling new recipient meta: %v", err))
	}

	return string(tmp)
}

func GetMeta(inputJsonString string) (outputJsonString string) {
	var recipientInputData RecipientInputMeta
	if err := json.Unmarshal([]byte(inputJsonString), &recipientInputData); err != nil {
		log.Printf("error while unmarshalling input string: %v", err)
		panic(fmt.Errorf("error while unmarshalling input string: %v", err))
	}

	var recipientNewMeta RecipientNewMeta

	recipientNewMeta.PK_k = recipientInputData.PK_k
	recipientNewMeta.PK_v = recipientInputData.PK_v

	var k SECP256K1_fr.Element
	kBytes, err := hex.DecodeString(recipientNewMeta.PK_k)

	if err != nil {
		log.Printf("error decoding string for k: %v", err)
		panic(fmt.Errorf("error decoding string for k: %v", err))
	}

	k.Unmarshal(kBytes)
	var k_asBigInt big.Int
	k.BigInt(&k_asBigInt)
	var K SECP256K1.G1Affine
	K.ScalarMultiplicationBase(&k_asBigInt)

	var v BN254_fr.Element
	vBytes, err := hex.DecodeString(recipientNewMeta.PK_v)

	if err != nil {
		log.Printf("error decoding string for v: %v", err)
		panic(fmt.Errorf("error decoding string for v: %v", err))
	}

	v.Unmarshal(vBytes)
	var v_asBigInt big.Int
	v.BigInt(&v_asBigInt)
	var V BN254.G1Affine
	V.ScalarMultiplicationBase(&v_asBigInt)

	recipientNewMeta.K = utils.PackXY(K.X.String(), K.Y.String())
	recipientNewMeta.V = utils.PackXY(V.X.String(), V.Y.String())

	tmp, err := json.Marshal(recipientNewMeta)

	if err != nil {
		log.Printf("error marshaling new recipient meta: %v", err)
		panic(fmt.Errorf("error marshaling new recipient meta: %v", err))
	}

	return string(tmp)
}

func Scan(inputJsonString string) (outputJsonString string) {

	var recipientInputData RecipientInputData
	if err := json.Unmarshal([]byte(inputJsonString), &recipientInputData); err != nil {
		log.Printf("error marshalling input string: %v", err)
		panic(fmt.Errorf("error marshalling input string: %v", err))
	}

	Rs_string := recipientInputData.Rs

	var Rs []BN254.G1Affine

	nBytesInViewTag := 1

	for i := 0; i < len(Rs_string); i++ {

		RsiX, RsiY := utils.UnpackXY(Rs_string[i])

		var Rsi BN254.G1Affine
		Rsi.X.SetString(RsiX)
		Rsi.Y.SetString(RsiY)

		Rs = append(Rs, Rsi)
	}

	var k SECP256K1_fr.Element
	kBytes, err := hex.DecodeString(recipientInputData.PK_k)

	if err != nil {
		log.Printf("error decoding string for k: %v", err)
		panic(fmt.Errorf("error decoding string for k: %v", err))
	}

	k.Unmarshal(kBytes)
	var k_asBigInt big.Int
	k.BigInt(&k_asBigInt)

	var v BN254_fr.Element
	vBytes, err := hex.DecodeString(recipientInputData.PK_v)

	if err != nil {
		log.Printf("error decoding string for v: %v", err)
		panic(fmt.Errorf("error decoding string for v: %v", err))
	}

	v.Unmarshal(vBytes)
	var v_asBigInt big.Int
	v.BigInt(&v_asBigInt)

	var K SECP256K1.G1Affine
	K.ScalarMultiplicationBase(&k_asBigInt)

	var V BN254.G1Affine
	V.ScalarMultiplicationBase(&v_asBigInt)

	var b SECP256K1_fr.Element
	var kb SECP256K1_fr.Element

	var recipientOutputData RecipientOutputData
	recipientOutputData.SpendingPrivKeys = []string{}
	recipientOutputData.SpendingPubKeys = []string{}

	for i, Rsi := range Rs {

		tmp := utils.BN254_MulG1PointandElement(&Rsi, &v)
		calculatedViewTag := utils.ComputeViewTag("v1-1byte", &tmp)

		if calculatedViewTag != recipientInputData.ViewTags[i][:2*nBytesInViewTag] {
			continue
		}

		var P SECP256K1.G1Affine
		S := computeSharedSecret(&v, &Rsi)
		b = compute_b_asElement(&S)
		_, G1 := SECP256K1.Generators()
		kb.Mul(&k, &b)

		P.ScalarMultiplication(&G1, kb.BigInt(new(big.Int)))
		recipientOutputData.SpendingPubKeys = append(recipientOutputData.SpendingPubKeys, utils.PackXY(P.X.String(), P.Y.String()))
		recipientOutputData.SpendingPrivKeys = append(recipientOutputData.SpendingPrivKeys, "0x"+kb.Text(16))
	}

	tmp, err := json.Marshal(recipientOutputData)

	if err != nil {
		log.Printf("error marshalling recipient output data: %v", err)
		panic(fmt.Errorf("error marshalling recipient output data: %v", err))
	}

	return string(tmp)
}

func compute_b(pubKey *BN254.GT) (b big.Int) {

	return *pubKey.C0.B0.A0.BigInt(new(big.Int))
}

func compute_b_asElement(pubKey *BN254.GT) (b SECP256K1_fr.Element) {

	b_asBigInt := compute_b(pubKey)

	return *b.SetBigInt(&b_asBigInt)
}

// Computes the shared secret - from sender's perspective
func computeSharedSecret(v *BN254_fr.Element, R *BN254.G1Affine) BN254.GT {

	rBigInt := new(big.Int)
	v.BigInt(rBigInt)

	var R_Jac BN254.G1Jac
	var vR_product BN254.G1Jac
	vR_product.ScalarMultiplication(R_Jac.FromAffine(R), rBigInt)

	var productAffine BN254.G1Affine
	productAffine.FromJacobian(&vR_product)

	// Compute pairing
	_, g2Gen, _, _ := BN254.Generators()

	one := new(big.Int)
	one.SetString("1", 10)

	var G2Jac BN254.G2Jac
	G2Jac.ScalarMultiplication(&g2Gen, one)

	var G2Aff BN254.G2Affine
	G2Aff.FromJacobian(&G2Jac)

	P, err := BN254.Pair([]BN254.G1Affine{productAffine}, []BN254.G2Affine{G2Aff})

	if err != nil {
		log.Printf("error while pairing calculates: %v", err)
		panic(fmt.Errorf("error while pairing calculates: %v", err))
	}

	return P
}

type RecipientNewMeta struct {
	PK_k string `json:"k"`
	PK_v string `json:"v"`
	K    string `json:"K"`
	V    string `json:"V"`
}

type RecipientInputMeta struct {
	PK_k string `json:"k"`
	PK_v string `json:"v"`
}

type RecipientInputData struct {
	PK_k     string   `json:"k"`
	PK_v     string   `json:"v"`
	Rs       []string `json:"Rs"`
	ViewTags []string `json:"viewTags"`
}

type RecipientOutputData struct {
	SpendingPubKeys  []string `json:"spendingPubKeys"`
	SpendingPrivKeys []string `json:"spendingPrivKeys"`
}

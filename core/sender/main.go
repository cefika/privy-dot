package sender

import (
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

func Send(inputJsonString string) (outputJsonString string) {

	var senderInputData SenderInputData
	if err := json.Unmarshal([]byte(inputJsonString), &senderInputData); err != nil {
		log.Printf("error while unmarshalling input string: %v", err)
		panic(fmt.Errorf("error while unmarshalling input string: %v", err))
	}

	fmt.Printf("SenderInputData %+v\n", senderInputData)

	var K SECP256K1.G1Affine
	Kx, Ky := utils.UnpackXY(senderInputData.K)
	K.X.SetString(Kx)
	K.Y.SetString(Ky)

	var V BN254.G1Affine
	Vx, Vy := utils.UnpackXY(senderInputData.V)
	V.X.SetString(Vx)
	V.Y.SetString(Vy)

	var r BN254_fr.Element
	r.SetRandom()

	var senderOutputData SenderOutputData
	senderOutputData.PK_r = r.String()
	R, err := utils.BN254_CalcG1PubKey(r)

	if err != nil {
		log.Printf("error while calculating R: %v", err)
		panic(fmt.Errorf("error while calculating R: %v", err))
	}

	senderOutputData.R = utils.PackXY(R.X.String(), R.Y.String())

	S := computeSharedSecret(&r, &V)
	b_asElement := compute_b_asElement(&S)
	spendingPubKey := computePubKey(&b_asElement, &K)
	senderOutputData.SpendingPubKey = utils.PackXY(spendingPubKey.X.String(), spendingPubKey.Y.String())

	tmp := utils.BN254_MulG1PointandElement(&V, &r)
	senderOutputData.ViewTag = utils.ComputeViewTag("v1-1byte", &tmp)

	jsonData, err := json.Marshal(senderOutputData)

	if err != nil {
		log.Printf("error while marshalling sender output data: %v", err)
		panic(fmt.Errorf("error while marshalling sender output data: %v", err))
	}

	return string(jsonData)
}

// Computes the shared secret - from sender's perspective
func computeSharedSecret(r *BN254_fr.Element, V *BN254.G1Affine) BN254.GT {

	rBigInt := new(big.Int)
	r.BigInt(rBigInt)

	// Perform scalar multiplication of V by r
	var V_Jac BN254.G1Jac
	var rV_product BN254.G1Jac
	rV_product.ScalarMultiplication(V_Jac.FromAffine(V), rBigInt)

	var productAffine BN254.G1Affine
	productAffine.FromJacobian(&rV_product)

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

func compute_b(pubKey *BN254.GT) (b big.Int) {

	return *pubKey.C0.B0.A0.BigInt(new(big.Int))
}

func compute_b_asElement(pubKey *BN254.GT) (b SECP256K1_fr.Element) {

	b_asBigInt := compute_b(pubKey)

	return *b.SetBigInt(&b_asBigInt)
}

func computePubKey(b *SECP256K1_fr.Element, K *SECP256K1.G1Affine) SECP256K1.G1Affine {

	var b_asBigInt big.Int
	b.BigInt(&b_asBigInt)

	var P SECP256K1.G1Affine
	P.ScalarMultiplication(K, &b_asBigInt)

	return P
}

type SenderInputData struct {
	K string `json:"K"`
	V string `json:"V"`
}

type SenderOutputData struct {
	PK_r           string `json:"r"`
	R              string `json:"R"`
	ViewTag        string `json:"viewTag"`
	SpendingPubKey string `json:"spendingPubKey"`
}

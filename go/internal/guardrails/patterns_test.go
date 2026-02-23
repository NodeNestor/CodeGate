package guardrails

import (
	"strings"
	"testing"
)

func TestEmailPattern(t *testing.T) {
	text := "Contact john.doe@example.com for info"
	result, count := createPatternGuardrail(emailPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected email detection")
	}
	if strings.Contains(result, "john.doe@example.com") {
		t.Error("email should be anonymized")
	}
	if !strings.Contains(result, "@anon.com") {
		t.Error("replacement should contain @anon.com")
	}
}

func TestPhonePattern(t *testing.T) {
	text := "Call me at 555-123-4567"
	result, count := createPatternGuardrail(phonePatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected phone detection")
	}
	if strings.Contains(result, "555-123-4567") {
		t.Error("phone should be anonymized")
	}
}

func TestSSNPattern(t *testing.T) {
	text := "SSN is 123-45-6789"
	result, count := createPatternGuardrail(ssnPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected SSN detection")
	}
	if !strings.Contains(result, "[SSN-") {
		t.Error("replacement should have [SSN- prefix")
	}
}

func TestSSNValidator_InvalidAreas(t *testing.T) {
	// Area 000, 666, 9xx should be rejected
	invalid := []string{"000-12-3456", "666-12-3456", "900-12-3456"}
	for _, ssn := range invalid {
		if ssnPatternDef.Validator(ssn) {
			t.Errorf("SSN %q should be invalid", ssn)
		}
	}
}

func TestCreditCardPattern(t *testing.T) {
	text := "Card: 4111 1111 1111 1111"
	result, count := createPatternGuardrail(creditCardPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected credit card detection")
	}
	if !strings.Contains(result, "[VISA-") {
		t.Error("Visa card should have [VISA- prefix")
	}
}

func TestIBANPattern(t *testing.T) {
	text := "IBAN: GB29NWBK60161331926819"
	result, count := createPatternGuardrail(ibanPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected IBAN detection")
	}
	if !strings.Contains(result, "[IBAN-") {
		t.Error("replacement should have [IBAN- prefix")
	}
}

func TestPassportPattern(t *testing.T) {
	text := "My passport number is 123456789"
	result, count := createPatternGuardrail(passportPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected passport detection")
	}
	if !strings.Contains(result, "[PASSPORT-") {
		t.Error("replacement should have [PASSPORT- prefix")
	}
}

func TestPassportRequiresContext(t *testing.T) {
	// Without context keyword, passport should not trigger
	g := createPatternGuardrail(passportPatternDef)
	if g.ShouldRun("Number is 123456789", "pre_call") {
		t.Error("passport should not run without context keyword")
	}
}

func TestIPAddressPattern(t *testing.T) {
	text := "Server at 192.168.1.100"
	result, count := createPatternGuardrail(ipAddressPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected IP detection")
	}
	if !strings.Contains(result, "[IP-") {
		t.Error("replacement should have [IP- prefix")
	}
}

func TestStreetAddressPattern(t *testing.T) {
	text := "Lives at 123 Main Street"
	result, count := createPatternGuardrail(streetAddressPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected address detection")
	}
	if !strings.Contains(result, "[ADDR-") {
		t.Error("replacement should have [ADDR- prefix")
	}
}

func TestAWSKeysPattern(t *testing.T) {
	text := "Key: AKIAIOSFODNN7EXAMPLE"
	result, count := createPatternGuardrail(awsKeysPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected AWS key detection")
	}
	if !strings.Contains(result, "[AKIA-") {
		t.Error("replacement should have [AKIA- prefix")
	}
}

func TestJWTPattern(t *testing.T) {
	text := "Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
	result, count := createPatternGuardrail(jwtPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected JWT detection")
	}
	if !strings.Contains(result, "[JWT-") {
		t.Error("replacement should have [JWT- prefix")
	}
}

func TestPrivateKeyPattern(t *testing.T) {
	text := "-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJBALRi...\n-----END RSA PRIVATE KEY-----"
	result, count := createPatternGuardrail(privateKeyPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected private key detection")
	}
	if !strings.Contains(result, "[PRIVATE-KEY-") {
		t.Error("replacement should have [PRIVATE-KEY- prefix")
	}
}

func TestURLAuthPattern(t *testing.T) {
	text := "Connect to https://user:pass123@db.example.com/mydb"
	result, count := createPatternGuardrail(urlAuthPatternDef).Execute(text)
	if count == 0 {
		t.Fatal("expected URL auth detection")
	}
	if strings.Contains(result, "pass123") {
		t.Error("password should be redacted from URL")
	}
	if !strings.Contains(result, "[redacted-") {
		t.Error("replacement should contain [redacted-")
	}
}

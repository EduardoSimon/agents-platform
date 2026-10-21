package main

import "testing"

func TestSwapToken(t *testing.T) {
	got, ok := SwapToken("placeholder-1", map[string]string{"placeholder-1": "real"})
	if !ok || got != "real" {
		t.Fatalf("SwapToken = %q, %v; want %q, true", got, ok, "real")
	}
	if _, ok := SwapToken("unknown", nil); ok {
		t.Fatal("unknown placeholder must not resolve")
	}
}

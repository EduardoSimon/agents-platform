package main

import "fmt"

// SwapToken returns the real token for a placeholder, if one is known.
func SwapToken(placeholder string, tokens map[string]string) (string, bool) {
	real, ok := tokens[placeholder]
	return real, ok
}

func main() {
	fmt.Println("egress: placeholder")
}

//go:build !windows

package main

import "errors"

// The agent is built for Windows; elsewhere only `run` works (tests, development).

func isService() bool { return false }
func runService()     {}

func install(string, []string, int, bool) error { return errors.New("install works on Windows only") }
func uninstall() error                          { return errors.New("uninstall works on Windows only") }

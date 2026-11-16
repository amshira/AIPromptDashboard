//go:build !windows

package main

// registeredProfiles: only Windows keeps a profile list; elsewhere (tests) the profiles folder is all.
func registeredProfiles() []osProfile { return nil }

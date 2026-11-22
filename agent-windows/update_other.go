//go:build !windows

package main

import "errors"

// The task-based swap uses Windows tools (schtasks, sc); elsewhere updates are a no-op so the package builds.

func applyUpdate([]byte) error { return errors.New("self-update works on Windows only") }

func scheduleStop() error { return errors.New("remote stop works on Windows only") }

func cleanupUpdateArtifacts() {}

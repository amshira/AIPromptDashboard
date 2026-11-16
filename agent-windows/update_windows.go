//go:build windows

package main

import (
	"os"
	"path/filepath"
)

// applyUpdate puts a received exe in place without this process ever writing over or launching its own binary.
// It stages the bytes as a data file, then registers a one-shot Scheduled Task that stops the service, copies
// the file into place and starts it again. Every program the task runs - schtasks, cmd, sc, copy - ships with
// Windows and is Microsoft-signed, and services.exe (not this agent) launches the new exe, exactly as on a
// fresh install. This is the "copy files, restart the service" dance install.ps1 already uses.
func applyUpdate(body []byte) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	return applyUpdateAt(exe, body, scheduleSwap)
}

// scheduleSwap writes a batch script and has Task Scheduler run it as SYSTEM, detached from this service so it
// keeps running after the service stops.
func scheduleSwap(exe, pkg string) error {
	script := filepath.Join(filepath.Dir(exe), updateScript)
	body := "@echo off\r\n" +
		"ping -n 4 127.0.0.1 >nul\r\n" + // let the HTTP reply flush before the service goes down
		"sc stop " + serviceName + " >nul 2>&1\r\n" +
		":waitstop\r\n" +
		"sc query " + serviceName + " | find \"STOPPED\" >nul\r\n" +
		"if errorlevel 1 ( ping -n 2 127.0.0.1 >nul & goto waitstop )\r\n" +
		"copy /y \"" + pkg + "\" \"" + exe + "\" >nul\r\n" +
		"sc start " + serviceName + " >nul 2>&1\r\n" +
		"del /q \"" + pkg + "\" >nul 2>&1\r\n" +
		"schtasks /delete /tn " + updateTaskName + " /f >nul 2>&1\r\n" +
		"del /q \"%~f0\" >nul 2>&1\r\n" // the script removes itself last
	if err := os.WriteFile(script, []byte(body), 0o644); err != nil {
		return err
	}
	// a one-shot task running as SYSTEM; /f overwrites any leftover from a previous update
	if err := run("schtasks", "/create", "/tn", updateTaskName, "/tr", `"`+script+`"`,
		"/sc", "once", "/st", "00:00", "/ru", "SYSTEM", "/rl", "HIGHEST", "/f"); err != nil {
		return err
	}
	return run("schtasks", "/run", "/tn", updateTaskName)
}

// cleanupUpdateArtifacts clears the staged file, the batch script and any leftover task after a restart.
func cleanupUpdateArtifacts() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	_ = os.Remove(exe + updatePkgSuffix)
	_ = os.Remove(filepath.Join(filepath.Dir(exe), updateScript))
	_ = run("schtasks", "/delete", "/tn", updateTaskName, "/f")
}

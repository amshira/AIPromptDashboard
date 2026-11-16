//go:build windows

package main

import (
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// registeredProfiles lists the user profiles Windows knows about (HKLM\...\ProfileList), wherever they
// live: a profile moved to another drive is found too, not just the folders under C:\Users.
// Each comes with its account as DOMAIN\user when Windows can still resolve the SID.
func registeredProfiles() []osProfile {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList`, registry.ENUMERATE_SUB_KEYS|registry.READ)
	if err != nil {
		return nil
	}
	defer k.Close()
	sids, err := k.ReadSubKeyNames(-1)
	if err != nil {
		return nil
	}
	var out []osProfile
	for _, sid := range sids {
		// S-1-5-21-…: real accounts; skips SYSTEM, LocalService and NetworkService
		if !strings.HasPrefix(sid, "S-1-5-21-") || strings.HasSuffix(sid, ".bak") {
			continue
		}
		sk, err := registry.OpenKey(k, sid, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		dir, _, err := sk.GetStringValue("ProfileImagePath")
		sk.Close()
		if err != nil || dir == "" {
			continue
		}
		dir, _ = registry.ExpandString(dir)
		out = append(out, osProfile{dir: dir, account: accountOf(sid)})
	}
	return out
}

func accountOf(sid string) string {
	s, err := windows.StringToSid(sid)
	if err != nil {
		return ""
	}
	user, domain, _, err := s.LookupAccount("")
	if err != nil || user == "" {
		return ""
	}
	if domain == "" {
		return user
	}
	return domain + `\` + user
}

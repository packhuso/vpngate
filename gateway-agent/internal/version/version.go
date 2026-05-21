// Package version exposes build metadata, injected via -ldflags.
package version

import "runtime"

var (
	Version   = "0.1.0-dev"
	Commit    = "none"
	BuildTime = "unknown"
)

// GoVersion returns the Go runtime version the binary was built with.
func GoVersion() string { return runtime.Version() }

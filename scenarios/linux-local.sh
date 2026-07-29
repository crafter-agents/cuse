#!/bin/sh
# Run the Linux accessibility gate on any machine, without waiting for CI.
#
# The AT-SPI work cannot be checked from a laptop that is not Linux, and a
# round trip through Actions is minutes per attempt. This is the same scenario
# the job runs, in a container: Xvfb, a session bus, openbox, GTK.
#
#   sh scenarios/linux-local.sh
#
# Nothing here is required to build or use cuse; it is for working on the Linux
# route. The gate that counts is the one in CI, on the real runner image.
set -e
cd "$(dirname "$0")/.."
docker build -f scenarios/linux-a11y.Dockerfile -t cuse-linux .
docker run -i --rm -v "$PWD:/work" cuse-linux bash -s <<'EOF'
set -e
# Build outside the mount so a Linux binary never lands in the host checkout.
cp -r /work /build
cd /build
bun test
bun build --compile src/cli.ts --outfile cuse
chmod +x scenarios/linux-atspi.sh
timeout 180 xvfb-run -a --server-args="-screen 0 1280x1024x24" \
  dbus-run-session -- ./scenarios/linux-atspi.sh
EOF

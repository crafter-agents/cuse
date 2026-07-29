FROM ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      xvfb xdotool x11-apps at-spi2-core python3-pyatspi zenity dbus-x11 \
      libgtk-3-0 gsettings-desktop-schemas openbox curl ca-certificates unzip \
      xterm xfonts-base bash \
    && rm -rf /var/lib/apt/lists/*
RUN set -eux; curl -fsSL https://bun.sh/install -o /tmp/bun-install.sh; bash /tmp/bun-install.sh
ENV PATH=/root/.bun/bin:$PATH
WORKDIR /work

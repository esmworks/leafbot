# Leaf Bot computer service: one sandboxed Linux desktop per bot. Build context is the repository root:
#   docker build -f computer/Dockerfile .      (docker/compose.yml does this)
# See "Botların bilgisayarı" in docker/README.md for the host setup.
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH ELECTRON_SKIP_BINARY_DOWNLOAD=1 CI=1
RUN corepack enable
WORKDIR /src
COPY . .
RUN pnpm install --frozen-lockfile --filter "@leafbot/computer..." \
 && pnpm --filter @leafbot/computer build

FROM node:22-bookworm-slim
# bubblewrap: one sandbox per bot. tigervnc: the virtual screen (Xvnc) the app watches. xfce parts:
# started one by one, without a session manager. google-chrome-stable: the bots' browser, from Google's
# own apt repository (amd64 and arm64). It is Google Chrome rather than Debian's Chromium because sites
# behind bot guards see the browser's brand ("Google Chrome" in its client hints) and trust the one
# most people use; Chrome also carries every language itself. Its apt source (ours and the one its
# install script writes) is removed afterwards: nothing updates packages inside the image. python3
# with openpyxl and python-docx: bots edit spreadsheets and documents with them. git: bots work on
# repositories, with GitHub reached through the controller's relay (computer/src/git-relay.ts).
# fonts: Turkish letters, emoji and CJK.
# The slim base leaves out every translation; keep Turkish so the desktop's menus follow the locale.
RUN printf 'path-include /usr/share/locale/tr/*\n' > /etc/dpkg/dpkg.cfg.d/zz-leafbot-locales \
 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && install -d -m 0755 /etc/apt/keyrings \
 && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub -o /etc/apt/keyrings/google-chrome.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/google-chrome.asc] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
    tini ca-certificates curl locales procps bubblewrap xdg-utils \
    tigervnc-standalone-server tigervnc-tools xauth x11-utils x11-xserver-utils dbus dbus-x11 \
    xfce4-panel xfwm4 xfdesktop4 xfce4-settings xfce4-terminal thunar mousepad \
    adwaita-icon-theme gnome-themes-extra-data \
    google-chrome-stable libreoffice-calc libreoffice-writer libreoffice-gtk3 libreoffice-l10n-tr \
    python3 python3-openpyxl python3-docx xdotool scrot git \
    fonts-dejavu-core fonts-liberation fonts-noto-color-emoji fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/google-chrome.* \
 && printf 'tr_TR.UTF-8 UTF-8\nen_US.UTF-8 UTF-8\n' >> /etc/locale.gen && locale-gen \
 && dbus-uuidgen --ensure=/etc/machine-id \
 && useradd --create-home --uid 10001 --shell /usr/sbin/nologin leafbot

# Desktop defaults (panel, wallpaper, default browser) and the browser launcher. Chrome's own menu
# entry is hidden: a Chrome started without the DevTools pipe could not be driven by the bot. Chrome
# registers itself as the default browser at priority 200, so the launcher takes it at 300.
# The launcher's earlier names stay as links: the panel copies its launchers into each bot's home on
# first start, and homes created before the rename still call the old path. Chrome's managed policy
# (etc/opt/chrome/policies) hides the "unsupported command-line flag" bar the anti-automation flags in
# computer/src/session.ts would put over every page: only a policy can turn it off. It also turns
# printing off, since a page's print preview would hold the page under it until the bot's step times
# out and the browser is closed, and blocks pages from asking for the location, whose question would
# wait on a bubble the bot does not answer. A policy leaves no trace in the page, as a script would.
COPY --chown=root:root computer/rootfs/ /
# corepack: the root file system is read-only for the bots, so the pnpm and yarn launchers go in here.
RUN corepack enable \
 && ln -s leafbot-browser /usr/local/bin/asistan-browser \
 && ln -s leafbot-browser /usr/local/bin/yumakbot-browser \
 && sed -i '0,/^\[Desktop Entry\]/s//[Desktop Entry]\nNoDisplay=true/' /usr/share/applications/google-chrome.desktop \
 && update-alternatives --install /usr/bin/x-www-browser x-www-browser /usr/local/bin/leafbot-browser 300 \
 && update-alternatives --install /usr/bin/gnome-www-browser gnome-www-browser /usr/local/bin/leafbot-browser 300

# Application files belong to root and stay read-only for the service user.
COPY --from=build --chown=root:root /src/computer/dist /srv/computer/dist
COPY --chown=root:root computer/session.sh /srv/computer/session.sh
WORKDIR /srv/computer
ENV NODE_ENV=production \
    LEAFBOT_COMPUTER_PORT=4320 \
    LEAFBOT_COMPUTER_STATE=/run/computer \
    LEAFBOT_WORKSPACES_ROOT=/data/workspaces \
    HOME=/home/leafbot
USER leafbot
EXPOSE 4320
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD node -e "fetch('http://127.0.0.1:4320/health',{headers:{authorization:'Bearer '+process.env.LEAFBOT_COMPUTER_TOKEN}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.mjs"]

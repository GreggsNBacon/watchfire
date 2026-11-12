Watchfire for Linux
===================

Watchfire opens ports on your router for game servers (UPnP), so friends outside your home can join.

Install on Ubuntu, Debian, Mint and others based on them (the .deb from the release page):

  sudo apt install ./watchfire_<version>_amd64.deb

Any other Linux (this tarball), for your user only, no sudo:

  ./install.sh

Then open Watchfire from your apps menu. It opens in its own window when Chrome, Chromium, Edge,
Brave or Vivaldi is installed, otherwise in a tab of your browser. Closing the window quits it;
"Start at login" in its settings opens it when you log in.

On a server without a desktop, run watchfire there and open its page through an SSH tunnel:

  watchfire --port 8790
  ssh -L 8790:127.0.0.1:8790 you@your-server     then open http://127.0.0.1:8790 on your computer

Your router needs UPnP turned on. Game servers on this machine are recognised from their running
programs (it uses "ss" for their ports, from the iproute2 package that nearly every Linux has).

Settings and your custom games: ~/.local/share/Watchfire
Remove: sudo apt remove watchfire (the .deb), or ./install.sh --remove (the tarball)

Emberkeep, the game server manager, opens ports with UPnP itself, so on Linux you don't need
Watchfire for its servers.

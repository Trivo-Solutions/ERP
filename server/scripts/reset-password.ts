import { config } from 'dotenv';
config();
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

// Operator break-glass: set ONE login's password. Nothing is hardcoded — pass the target and the new password in the
// environment (never on the command line, so it stays out of the process list), e.g. in PowerShell:
//   $env:RESET_EMAIL='user@example.com'; $env:RESET_PASSWORD='<new password>'; npm run reset:passwords
// Revokes every existing session of that login (passwordChangedAt). Refuses to run against production: there, use the
// company admin's Reset Password (Settings > Users) or the person's own Change Password screen.
const prisma = new PrismaClient();

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run with NODE_ENV=production');
  const email = process.env.RESET_EMAIL?.trim().toLowerCase();
  const password = process.env.RESET_PASSWORD;
  if (!email || !password) throw new Error('Set RESET_EMAIL and RESET_PASSWORD');
  if (password.length < 12) throw new Error('RESET_PASSWORD must be at least 12 characters');
  const hash = await bcrypt.hash(password, 12);
  const updated = await prisma.user.update({
    where: { email },
    data: { password: hash, passwordChangedAt: new Date(Math.floor(Date.now() / 1000) * 1000) },
    select: { email: true, name: true },
  });
  console.log(`Password reset for ${updated.email} (${updated.name})`);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e.message ?? e); prisma.$disconnect(); process.exit(1); });

import { config } from 'dotenv';
config();
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  const users = [
    { email: 'admin@sea-erp.com',   password: 'Admin@123' },
    { email: 'manager@sea-erp.com', password: 'Welcome@123' },
  ];

  for (const u of users) {
    const hash = await bcrypt.hash(u.password, 12);
    const updated = await prisma.user.update({
      where: { email: u.email },
      data: { password: hash },
      select: { email: true, name: true },
    });
    console.log(`✅ Reset: ${updated.email} (${updated.name})`);
  }

  console.log('\nCredentials:');
  console.log('  admin@sea-erp.com   → Admin@123');
  console.log('  manager@sea-erp.com → Welcome@123');
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); prisma.$disconnect(); process.exit(1); });

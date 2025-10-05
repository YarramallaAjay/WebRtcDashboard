import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Fetching current cameras...');
  const cameras = await prisma.camera.findMany({
    select: { id: true, name: true, rtspUrl: true, enabled: true, status: true }
  });

  console.log('\nCurrent cameras:');
  cameras.forEach((cam, i) => {
    console.log(`${i + 1}. ${cam.name} (${cam.id})`);
    console.log(`   RTSP: ${cam.rtspUrl}`);
    console.log(`   Status: ${cam.status}, Enabled: ${cam.enabled}\n`);
  });

  // Update cameras with local RTSP URLs
  const localUrls = [
    'rtsp://mediamtx:8554/local-cam-1',
    'rtsp://mediamtx:8554/local-cam-2',
    'rtsp://mediamtx:8554/local-cam-3'
  ];

  console.log('Updating cameras with local RTSP URLs...\n');

  for (let i = 0; i < Math.min(cameras.length, 3); i++) {
    const updated = await prisma.camera.update({
      where: { id: cameras[i].id },
      data: {
        rtspUrl: localUrls[i],
        status: 'OFFLINE',
        enabled: false
      }
    });
    console.log(`✓ Updated ${updated.name} → ${localUrls[i]}`);
  }

  console.log('\n✅ Cameras updated successfully!');
  console.log('You can now start them from the UI.');
}

main()
  .catch((e) => {
    console.error('Error:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

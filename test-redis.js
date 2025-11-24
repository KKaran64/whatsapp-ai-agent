require('dotenv').config();
const Bull = require('bull');

const testRedis = async () => {
  console.log('Testing Redis connection...\n');
  console.log('Redis URL:', process.env.REDIS_URL);

  try {
    // Create a test queue
    const testQueue = new Bull('test-queue', process.env.REDIS_URL, {
      redis: {
        tls: {
          rejectUnauthorized: false
        }
      }
    });

    console.log('✅ Queue created');

    // Add a test job
    const job = await testQueue.add('test-job', { message: 'Hello Redis!' });
    console.log('✅ Job added to queue:', job.id);

    // Process the job
    testQueue.process('test-job', async (job) => {
      console.log('✅ Processing job:', job.data.message);
      return { success: true };
    });

    // Wait a moment
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check queue status
    const jobCounts = await testQueue.getJobCounts();
    console.log('📊 Queue status:', jobCounts);

    await testQueue.close();
    console.log('\n✅ Redis is working!');

    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
};

testRedis();

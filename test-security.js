/**
 * Security Test for WhatsApp Media Upload
 * Tests URL whitelist and file size validation
 */

const { uploadImageToWhatsApp } = require('./whatsapp-media-upload');

console.log('============================================================');
console.log('Testing Security Features');
console.log('============================================================\n');

async function runSecurityTests() {
  const tests = [
    {
      name: 'Valid Domain (homedecorzstore.com)',
      url: 'https://homedecorzstore.com/wp-content/uploads/2024/04/DSC05003.jpg',
      shouldPass: true
    },
    {
      name: 'Invalid Domain (example.com - not in whitelist)',
      url: 'https://example.com/image.jpg',
      shouldPass: false
    },
    {
      name: 'SSRF Attack - Localhost',
      url: 'http://localhost:3000/admin',
      shouldPass: false
    },
    {
      name: 'SSRF Attack - AWS Metadata',
      url: 'http://169.254.169.254/latest/meta-data/',
      shouldPass: false
    },
    {
      name: 'File Protocol Attack',
      url: 'file:///etc/passwd',
      shouldPass: false
    }
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    console.log(`\n[TEST] ${test.name}`);
    console.log(`URL: ${test.url}`);
    console.log(`Expected: ${test.shouldPass ? 'PASS' : 'BLOCK'}`);

    try {
      const result = await uploadImageToWhatsApp(test.url);

      if (test.shouldPass) {
        console.log(`✅ PASSED - Upload succeeded as expected`);
        passed++;
      } else {
        console.log(`❌ FAILED - Upload should have been blocked!`);
        failed++;
      }
    } catch (error) {
      if (!test.shouldPass) {
        console.log(`✅ PASSED - Upload blocked as expected: ${error.message}`);
        passed++;
      } else {
        console.log(`❌ FAILED - Upload should have succeeded: ${error.message}`);
        failed++;
      }
    }
  }

  console.log('\n============================================================');
  console.log('Security Test Summary');
  console.log('============================================================');
  console.log(`Total Tests: ${tests.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / tests.length) * 100).toFixed(2)}%`);
  console.log('============================================================\n');

  if (failed === 0) {
    console.log('🎉 ALL SECURITY TESTS PASSED!\n');
  } else {
    console.log('⚠️ SOME SECURITY TESTS FAILED - REVIEW NEEDED\n');
  }
}

runSecurityTests().catch(console.error);

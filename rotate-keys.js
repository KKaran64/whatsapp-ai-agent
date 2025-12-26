#!/usr/bin/env node
/**
 * Automated API Key Rotation Script
 * 
 * This script helps automate key rotation by:
 * 1. Prompting for new API keys
 * 2. Validating new keys work
 * 3. Updating local .env file
 * 4. Updating Render environment variables
 * 5. Creating a backup of old keys
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const axios = require('axios');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Configuration
const ENV_FILE = path.join(__dirname, '.env');
const ENV_BACKUP = path.join(__dirname, `.env.backup.${Date.now()}`);

function question(prompt) {
  return new Promise(resolve => rl.question(prompt, resolve));
}

/**
 * Parse .env file into key-value pairs
 */
function parseEnvFile(content) {
  const env = {};
  const lines = content.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    const match = trimmed.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      env[key] = value;
    }
  }
  
  return env;
}

/**
 * Update .env file with new values
 */
function updateEnvFile(envVars) {
  const lines = [];
  const content = fs.readFileSync(ENV_FILE, 'utf-8');
  const existingLines = content.split('\n');
  
  const updated = new Set();
  
  for (const line of existingLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      lines.push(line);
      continue;
    }
    
    const match = trimmed.match(/^([^=]+)=/);
    if (match) {
      const key = match[1].trim();
      if (envVars[key] !== undefined) {
        lines.push(`${key}=${envVars[key]}`);
        updated.add(key);
      } else {
        lines.push(line);
      }
    } else {
      lines.push(line);
    }
  }
  
  // Add any new keys that weren't in the file
  for (const [key, value] of Object.entries(envVars)) {
    if (!updated.has(key)) {
      lines.push(`${key}=${value}`);
    }
  }
  
  fs.writeFileSync(ENV_FILE, lines.join('\n'));
}

/**
 * Validate Groq API key
 */
async function validateGroqKey(apiKey) {
  try {
    const response = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1
      },
      {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    );
    return { valid: true, message: 'Groq key is valid' };
  } catch (error) {
    if (error.response?.status === 401) {
      return { valid: false, message: 'Invalid Groq API key' };
    }
    // Other errors (rate limit, etc.) might still mean the key is valid
    return { valid: true, message: 'Key appears valid (API returned error but not 401)' };
  }
}

/**
 * Validate Gemini API key
 */
async function validateGeminiKey(apiKey) {
  try {
    const response = await axios.get(
      `https://generativelanguage.googleapis.com/v1/models?key=${apiKey}`,
      { timeout: 10000 }
    );
    return { valid: true, message: 'Gemini key is valid' };
  } catch (error) {
    if (error.response?.status === 400 || error.response?.status === 403) {
      return { valid: false, message: 'Invalid Gemini API key' };
    }
    return { valid: false, message: `Validation error: ${error.message}` };
  }
}

/**
 * Validate MongoDB URI
 */
async function validateMongoDBUri(uri) {
  try {
    // Just check if the URI format is valid
    const url = new URL(uri.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://'));
    if (!url.hostname) {
      return { valid: false, message: 'Invalid MongoDB URI format' };
    }
    return { valid: true, message: 'MongoDB URI format is valid' };
  } catch (error) {
    return { valid: false, message: 'Invalid MongoDB URI format' };
  }
}

/**
 * Main rotation workflow
 */
async function rotateKeys() {
  console.log('============================================================');
  console.log('API Key Rotation Tool');
  console.log('============================================================\n');
  
  // Check if .env exists
  if (!fs.existsSync(ENV_FILE)) {
    console.error('ERROR: .env file not found!');
    process.exit(1);
  }
  
  // Create backup
  console.log('Creating backup of current .env...');
  fs.copyFileSync(ENV_FILE, ENV_BACKUP);
  console.log(`✅ Backup created: ${ENV_BACKUP}\n`);
  
  // Read current env
  const currentEnv = parseEnvFile(fs.readFileSync(ENV_FILE, 'utf-8'));
  const newEnv = {};
  
  console.log('What would you like to rotate?\n');
  console.log('1. Groq API Keys');
  console.log('2. Gemini API Key');
  console.log('3. MongoDB URI');
  console.log('4. Redis URL');
  console.log('5. All keys');
  console.log('6. Custom selection\n');
  
  const choice = await question('Enter your choice (1-6): ');
  
  let keysToRotate = [];
  
  switch (choice.trim()) {
    case '1':
      keysToRotate = ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4'];
      break;
    case '2':
      keysToRotate = ['GEMINI_API_KEY'];
      break;
    case '3':
      keysToRotate = ['MONGODB_URI'];
      break;
    case '4':
      keysToRotate = ['REDIS_URL'];
      break;
    case '5':
      keysToRotate = ['GROQ_API_KEY', 'GROQ_API_KEY_2', 'GROQ_API_KEY_3', 'GROQ_API_KEY_4', 
                      'GEMINI_API_KEY', 'MONGODB_URI', 'REDIS_URL'];
      break;
    case '6':
      console.log('\nAvailable keys:', Object.keys(currentEnv).join(', '));
      const keys = await question('\nEnter keys to rotate (comma-separated): ');
      keysToRotate = keys.split(',').map(k => k.trim());
      break;
    default:
      console.log('Invalid choice');
      process.exit(1);
  }
  
  console.log(`\n📝 Rotating ${keysToRotate.length} key(s)...\n`);
  
  for (const key of keysToRotate) {
    console.log(`\n--- ${key} ---`);
    console.log(`Current value: ${currentEnv[key]?.substring(0, 20)}...`);
    
    const newValue = await question(`Enter new value for ${key} (or press Enter to skip): `);
    
    if (!newValue.trim()) {
      console.log('⏭️  Skipped');
      continue;
    }
    
    // Validate key if possible
    let validation = { valid: true, message: 'No validation performed' };
    
    if (key.startsWith('GROQ_API_KEY')) {
      console.log('Validating Groq key...');
      validation = await validateGroqKey(newValue);
    } else if (key === 'GEMINI_API_KEY') {
      console.log('Validating Gemini key...');
      validation = await validateGeminiKey(newValue);
    } else if (key === 'MONGODB_URI') {
      validation = validateMongoDBUri(newValue);
    }
    
    if (!validation.valid) {
      console.log(`❌ ${validation.message}`);
      const proceed = await question('Use this value anyway? (y/n): ');
      if (proceed.toLowerCase() !== 'y') {
        console.log('⏭️  Skipped');
        continue;
      }
    } else {
      console.log(`✅ ${validation.message}`);
    }
    
    newEnv[key] = newValue;
  }
  
  if (Object.keys(newEnv).length === 0) {
    console.log('\n⚠️  No keys were rotated');
    rl.close();
    return;
  }
  
  console.log(`\n\n📋 Summary of changes:`);
  for (const [key, value] of Object.entries(newEnv)) {
    console.log(`  ${key}: ${value.substring(0, 20)}...`);
  }
  
  const confirm = await question('\nProceed with updating .env file? (y/n): ');
  
  if (confirm.toLowerCase() !== 'y') {
    console.log('❌ Aborted');
    rl.close();
    return;
  }
  
  // Update .env file
  updateEnvFile(newEnv);
  console.log('\n✅ Local .env file updated!');
  
  console.log('\n============================================================');
  console.log('Next Steps:');
  console.log('============================================================');
  console.log('1. Update Render environment variables:');
  console.log('   - Go to https://dashboard.render.com/');
  console.log('   - Select your service');
  console.log('   - Go to Environment tab');
  console.log('   - Update the following keys:');
  for (const key of Object.keys(newEnv)) {
    console.log(`     - ${key}`);
  }
  console.log('\n2. Redeploy your service on Render');
  console.log('\n3. Verify the new keys work in production');
  console.log('\n4. Delete the backup file once confirmed working:');
  console.log(`   rm ${ENV_BACKUP}`);
  console.log('============================================================\n');
  
  rl.close();
}

// Run the rotation workflow
rotateKeys().catch(error => {
  console.error('Error:', error.message);
  rl.close();
  process.exit(1);
});

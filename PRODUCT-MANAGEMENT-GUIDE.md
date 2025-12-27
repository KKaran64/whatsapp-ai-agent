# Product Management Guide

This guide explains how to manage products in your WhatsApp bot's product database.

## Available Tools

### 1. **list-products.js** - View All Products
Lists all products currently in the database with their details.

```bash
node list-products.js
```

This shows:
- Total products and categories
- All products organized by category
- Product names, IDs, prices, aliases, tags, and images

### 2. **add-product.js** - Add New Products
Interactive tool to add new products to the database.

```bash
node add-product.js
```

The tool will ask you for:
- **Category** (select existing or create new)
- **Product name** (e.g., "Cork Water Bottle")
- **Price** (in ₹)
- **Aliases** (alternate names customers might use)
  - Example: "water bottle, borosil bottle, drinking bottle"
- **Tags** (keywords for searching)
  - Example: "water, bottle, drink, hydration"
- **Image URLs** (from your website)
  - Example: `https://9cork.com/wp-content/uploads/2023/12/DSC09266-1024x683.jpg`
  - You can add multiple images

### 3. **check-duplicates.js** - Check for Duplicate Images
Verifies that no two products share the same image URL.

```bash
node check-duplicates.js
```

### 4. **extract-keywords.js** - Generate Keywords
Extracts all keywords from the database for the bot to recognize.

```bash
node extract-keywords.js
```

## Step-by-Step: Adding a New Product

### Step 1: Add the Product

```bash
node add-product.js
```

Follow the prompts to enter all product information.

### Step 2: Check for Duplicates

```bash
node check-duplicates.js
```

Make sure there are no duplicate image URLs.

### Step 3: Generate New Keywords

```bash
node extract-keywords.js
```

This outputs a list of keywords like:
```
bag|bottle|card|coaster|desk|diary|holder|laptop|mat|pen|planter|wallet
```

### Step 4: Update server.js

Copy the keywords from Step 3 and update the `PRODUCT_KEYWORDS` regex in server.js:

1. Open `server.js`
2. Find the line with `PRODUCT_KEYWORDS` (around line 563)
3. Replace the keywords inside the regex with the new keywords:

```javascript
const PRODUCT_KEYWORDS = /(bag|bottle|card|coaster|desk|diary|holder|laptop|mat|pen|planter|wallet)/i;
```

### Step 5: Update Version

In `server.js`, update the version (around line 1217):

```javascript
version: 'ROBUST-v23-NEW-PRODUCTS-ADDED',
```

### Step 6: Test the Changes

```bash
node test-image-database.js
```

This tests that the bot can find all products correctly.

### Step 7: Commit and Deploy

```bash
# Commit changes
git add product-image-database.json server.js
git commit -m "Add new products to database"

# Push to GitHub (triggers auto-deployment on Render)
git push origin main
```

Or upload manually via GitHub web interface:
1. Go to https://github.com/KKaran64/whatsapp-ai-agent
2. Click "Add file" → "Upload files"
3. Upload: `product-image-database.json` and `server.js`
4. Commit changes

## Product Database Structure

Each product has:
```json
{
  "id": "category-001",
  "name": "Product Name",
  "aliases": ["alternate name 1", "alternate name 2"],
  "images": [
    "https://example.com/image1.jpg",
    "https://example.com/image2.jpg"
  ],
  "price": 250,
  "tags": ["tag1", "tag2", "tag3"]
}
```

## Tips

1. **Good Aliases**: Think about how customers might ask for the product
   - "card holder" → aliases: "business card holder", "card case", "visiting card holder"

2. **Good Tags**: Use simple, searchable keywords
   - Tags: "card", "holder", "business", "case"

3. **Image URLs**:
   - Use high-quality images from your website
   - Make sure URLs are permanent (not temporary links)
   - Test that images load before adding

4. **Prices**: Enter price in rupees as a number (no ₹ symbol)
   - ✅ 250
   - ❌ ₹250 or 250.00

## Current Categories

1. **coasters** - Cork Coasters
2. **desk_organizers** - Desk Organizers & Accessories
3. **diaries** - Cork Diaries & Notebooks
4. **planters** - Cork Planters
5. **bags_wallets** - Bags, Wallets & Accessories
6. **serving_decor** - Serving Trays & Table Décor
7. **tea_lights** - Tea Light Holders & Candles

## Troubleshooting

**Problem**: Bot sends wrong images
- **Solution**: Run `node check-duplicates.js` to find duplicate image URLs

**Problem**: Bot doesn't recognize a product name
- **Solution**:
  1. Add more aliases for that product
  2. Run `node extract-keywords.js`
  3. Update PRODUCT_KEYWORDS in server.js

**Problem**: Image doesn't show in WhatsApp
- **Solution**: Verify the image URL is publicly accessible and not expired

## Example: Adding a Water Bottle

```bash
$ node add-product.js

===========================================
ADD NEW PRODUCT TO DATABASE
===========================================

Available Categories:
  1. coasters - Cork Coasters
  2. desk_organizers - Desk Organizers & Accessories
  3. diaries - Cork Diaries & Notebooks
  4. planters - Cork Planters
  5. bags_wallets - Bags, Wallets & Accessories
  6. serving_decor - Serving Trays & Table Décor
  7. tea_lights - Tea Light Holders & Candles

Select category number (or press Enter to create new): [Enter]

--- Creating New Category ---
Category key (e.g., "new_products"): bottles
Display name (e.g., "New Products"): Cork Bottles
Keywords (comma-separated, e.g., "new, product, item"): bottle, water, drink, hydration

✅ New category "Cork Bottles" created!

--- Product Details ---
Product name: Cork Water Bottle
Price (in ₹): 350

Aliases (alternate names customers might use):
Example: "card holder", "business card holder", "keychain"
Aliases (comma-separated): water bottle, drinking bottle, eco bottle, reusable bottle

Tags (keywords for this product):
Example: "card", "holder", "business"
Tags (comma-separated): water, bottle, drink, eco, reusable

Image URLs:
Example: https://9cork.com/wp-content/uploads/2023/12/DSC09266-1024x683.jpg
Image 1 URL (or press Enter to finish): https://9cork.com/wp-content/uploads/2024/01/bottle-001.jpg
  ✅ Image 1 added
Image 2 URL (or press Enter to finish): [Enter]

===========================================
PRODUCT SUMMARY
===========================================
{
  "id": "bottle-001",
  "name": "Cork Water Bottle",
  "aliases": ["water bottle", "drinking bottle", "eco bottle", "reusable bottle"],
  "images": ["https://9cork.com/wp-content/uploads/2024/01/bottle-001.jpg"],
  "price": 350,
  "tags": ["water", "bottle", "drink", "eco", "reusable"]
}
===========================================

Add this product to database? (yes/no): yes

✅ Product added successfully!
Total products in database: 28

⚠️  NEXT STEPS:
1. Run: node extract-keywords.js
2. Update PRODUCT_KEYWORDS in server.js with the new keywords
3. Run: node check-duplicates.js (to verify no duplicate images)
4. Run: node test-image-database.js (to test the changes)
```

## Need Help?

If you encounter any issues, check:
1. JSON syntax in product-image-database.json is valid
2. All image URLs are accessible
3. No duplicate image URLs exist
4. Keywords are updated in server.js after adding products

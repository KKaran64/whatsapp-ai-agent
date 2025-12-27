# Excel Workflow for Cork Products Database

## Overview
You can now manage your cork products database using Excel instead of manually editing JSON files.

## Files Created
- **cork-products-database.xlsx** - Excel file with all your cork products
- **export-to-excel.js** - Script to export JSON database to Excel
- **import-from-excel.js** - Script to import Excel changes back to JSON

## How to Add Pinterest Products

### Step 1: Open the Excel File
```bash
open cork-products-database.xlsx
```
(Or open it in Excel, Numbers, or Google Sheets)

### Step 2: Add New Products
Add new rows at the bottom with these columns:

| Product ID | Product Name | Category | Price (INR) | Image URL 1 | Image URL 2 | Image URL 3 | Aliases | Tags | Source |
|------------|--------------|----------|-------------|-------------|-------------|-------------|---------|------|--------|
| pinterest-001 | Cork Wall Hanging | Cork Planters | 450 | https://i.pinimg.com/... | | | wall decor, hanging planter | wall, hanging, pinterest | pinterest |

**Category Options:**
- Cork Coasters
- Cork Bags & Wallets
- Cork Diaries
- Cork Desk Organizers
- Cork Planters
- Cork Fridge Magnets
- Cork Serving & Decor
- Cork Photo Frames

**Product ID Format:**
- Use pattern: `category-###` or `pinterest-###`
- Examples: `planter-008`, `pinterest-001`, `bag-009`

### Step 3: Save the Excel File
Save your changes in Excel

### Step 4: Import Back to Database
```bash
node import-from-excel.js
```

### Step 5: Update Keywords and Server
```bash
node extract-keywords.js
# Copy output and update PRODUCT_KEYWORDS in server.js (lines 563-564)
node check-duplicates.js
```

## Example: Adding Pinterest Products

```excel
Product ID       | Product Name                    | Category        | Price | Image URL 1
pinterest-001    | Cork Chevron Wall Planter       | Cork Planters   | 550   | https://i.pinimg.com/originals/abc.jpg
pinterest-002    | Cork Yoga Mat Bag              | Cork Bags & Wallets | 899 | https://i.pinimg.com/564x/def.jpg
pinterest-003    | Cork Hexagon Coaster Set       | Cork Coasters   | 399   | https://i.pinimg.com/736x/ghi.jpg
```

**Tips:**
- Get Pinterest image URLs: Right-click on image → "Copy image address"
- Aliases: Comma-separated alternative names (e.g., "yoga bag, mat carrier, gym bag")
- Tags: Comma-separated keywords (e.g., "yoga, fitness, bag")
- You can add up to 3 image URLs per product

## Re-exporting to Excel
If you make changes to the JSON database manually, re-export to Excel:
```bash
node export-to-excel.js
```

## Current Database
- **Total Products:** 41
- **Version:** 1.3
- **Last Updated:** 2025-12-25
- **Sources:** 9cork.com, homedecorzstore.com

## Next Steps for Pinterest Products
1. Open `cork-products-database.xlsx`
2. Add Pinterest products from https://in.pinterest.com/9cork/
3. Get image URLs from Pinterest (right-click → copy image address)
4. Run `node import-from-excel.js`
5. Update server keywords
6. Test with WhatsApp bot

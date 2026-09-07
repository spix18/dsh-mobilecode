# Vision API Capability Test Suite

This test suite determines whether a vision API is usable for **visual UI typography/icon measurement**. It is designed to be run by any LLM with access to vision tools.

## Test Images

All test images are in the `test-images/` folder:

| File | Description | Role |
|---|---|---|
| `home-before.jpg` | Home screen BEFORE recalibration (1080×2400) | Test input |
| `home-after.png` | Home screen AFTER recalibration (1080×2400) | Test input |
| `skills-before.jpg` | Skills Map BEFORE recalibration (1080×2400) | Test input |
| `skills-after.png` | Skills Map AFTER recalibration (1080×2400) | Test input |
| `board-five-phones.png` | Design board with 5 phone mockups (1779×884) | Reference |
| `board-home-crop.png` | Cropped Home phone from board (343×755) | Reference |

---

## Test 1: Element Detection Reliability

**Objective:** Verify that the API can consistently detect UI elements.

**Procedure:**
1. Run `vision_detect` with category `all` on `home-before.jpg` THREE times
2. Count the number of elements detected each time
3. Run `vision_detect` with category `text` on `home-before.jpg` THREE times
4. Count the number of text elements detected each time

**Pass Criteria:**
- All 3 runs return the same number of elements (±10%)
- At least 10 elements detected in "all" mode
- At least 5 text elements detected in "text" mode

**Expected Output Format:**
```
Test 1: Element Detection Reliability
Run 1 (all): N elements
Run 2 (all): N elements
Run 3 (all): N elements
Consistent: YES/NO
Run 1 (text): N elements
Run 2 (text): N elements
Run 3 (text): N elements
Consistent: YES/NO
PASS/FAIL: [result]
```

---

## Test 2: Text Role Grounding Precision

**Objective:** Verify that the API can precisely locate and bound a specific text string.

**Procedure:**
1. Run `vision_ground` targeting `the text "STILL UP, SENIORUSER"` on `home-before.jpg`
2. Record the bounding box coordinates
3. Run `vision_ground` targeting `the text "LEVEL 01"` on `home-before.jpg`
4. Record the bounding box coordinates
5. Calculate the height of each bounding box

**Pass Criteria:**
- Both targets return exactly 1 match
- Bounding box height is between 20px and 80px (reasonable for title text)
- Bounding box width is between 100px and 500px
- Coordinates are within image bounds (0,0 to 1080,2400)

**Expected Output Format:**
```
Test 2: Text Role Grounding Precision
Target 1: "STILL UP, SENIORUSER"
  Matches: N
  Box: [x1, y1, x2, y2]
  Height: N px
  Width: N px
  Reasonable size: YES/NO
Target 2: "LEVEL 01"
  Matches: N
  Box: [x1, y1, x2, y2]
  Height: N px
  Width: N px
  Reasonable size: YES/NO
PASS/FAIL: [result]
```

---

## Test 3: Cross-Image Consistency

**Objective:** Verify that the API returns consistent measurements for the same semantic role across BEFORE and AFTER images.

**Procedure:**
1. Run `vision_ground` targeting `the screen title text` on `home-before.jpg`
2. Run `vision_ground` targeting `the screen title text` on `home-after.png`
3. Compare the bounding box heights

**Pass Criteria:**
- Both images return exactly 1 match
- Height difference is less than 30px (titles should be similar size)
- Both boxes are in the upper third of the screen (y < 800)

**Expected Output Format:**
```
Test 3: Cross-Image Consistency
BEFORE title box: [x1, y1, x2, y2], height=N
AFTER title box: [x1, y1, x2, y2], height=N
Height difference: N px
Consistent position: YES/NO
PASS/FAIL: [result]
```

---

## Test 4: Board Phone Detection

**Objective:** Verify that the API can detect individual phone mockups in a design board.

**Procedure:**
1. Run `vision_detect` with category `phone mockups/screens` on `board-five-phones.png`
2. Count the number of phones detected
3. Run `vision_ground` targeting `the Home phone (leftmost)` on `board-five-phones.png`

**Pass Criteria:**
- At least 4 phones detected
- Each phone has reasonable bounds (width 200-500px, height 400-900px)
- Home phone ground returns exactly 1 match

**Expected Output Format:**
```
Test 4: Board Phone Detection
Phones detected: N
Phone 1 bounds: [x1, y1, x2, y2]
Phone 2 bounds: [x1, y1, x2, y2]
...
Home phone ground: [x1, y1, x2, y2]
PASS/FAIL: [result]
```

---

## Test 5: Viewport Crop Extraction

**Objective:** Verify that the API can crop a region of interest.

**Procedure:**
1. Use `vision_crop` to extract the Home phone from `board-five-phones.png` using bounds from Test 4
2. Save the crop to `results/home-phone-crop.png`
3. Run `vision_detect` with category `all` on the cropped image

**Pass Criteria:**
- Crop succeeds and produces a non-empty image
- At least 5 elements detected in the crop
- Crop dimensions match expected bounds (±10px)

**Expected Output Format:**
```
Test 5: Viewport Crop Extraction
Crop source: board-five-phones.png
Crop bounds: [x1, y1, x2, y2]
Crop size: W x H
Elements detected in crop: N
PASS/FAIL: [result]
```

---

## Test 6: Pixel Diff Localization

**Objective:** Verify that the API can find changed regions between BEFORE and AFTER.

**Procedure:**
1. Run `vision_pixel_diff` with `home-before.jpg` as original and `home-after.png` as rebuilt
2. Record the overall difference percentage
3. Record the worst regions and their bounds

**Pass Criteria:**
- Overall difference is between 1% and 50% (some change expected)
- At least 1 worst region identified
- Regions have reasonable bounds within the image

**Expected Output Format:**
```
Test 6: Pixel Diff Localization
Overall difference: N%
Worst region 1: [x1, y1, x2, y2], diff=N%
Worst region 2: [x1, y1, x2, y2], diff=N%
PASS/FAIL: [result]
```

---

## Test 7: Icon Detection

**Objective:** Verify that the API can detect and bound icons (not just text).

**Procedure:**
1. Run `vision_detect` with category `icons` on `home-before.jpg`
2. Count the number of icons detected
3. Run `vision_ground` targeting `the bottom navigation Home icon` on `home-before.jpg`

**Pass Criteria:**
- At least 3 icons detected
- Navigation icon ground returns exactly 1 match
- Icon bounds are reasonable (20-80px width/height)

**Expected Output Format:**
```
Test 7: Icon Detection
Icons detected: N
Nav icon ground: [x1, y1, x2, y2]
Nav icon size: W x H
PASS/FAIL: [result]
```

---

## Test 8: Determinism Check

**Objective:** Verify that the same call returns the same result multiple times.

**Procedure:**
1. Run `vision_detect` with category `text` on `home-before.jpg` 3 times
2. Compare the results

**Pass Criteria:**
- All 3 runs return the same number of elements
- All 3 runs return matching text labels (±1 label)

**Expected Output Format:**
```
Test 8: Determinism Check
Run 1: N elements, labels: [...]
Run 2: N elements, labels: [...]
Run 3: N elements, labels: [...]
Identical: YES/NO
PASS/FAIL: [result]
```

---

## Final Assessment

### Scoring
- Each PASS = 1 point
- Each FAIL = 0 points
- Maximum = 8 points

### Verdict
- **7-8 PASS:** Vision API is USABLE for visual measurement
- **4-6 PASS:** Vision API is PARTIALLY USABLE (workarounds needed)
- **0-3 PASS:** Vision API is NOT USABLE for visual measurement

### Required Output
```
=== FINAL ASSESSMENT ===
Test 1: PASS/FAIL
Test 2: PASS/FAIL
Test 3: PASS/FAIL
Test 4: PASS/FAIL
Test 5: PASS/FAIL
Test 6: PASS/FAIL
Test 7: PASS/FAIL
Test 8: PASS/FAIL
Total: N/8
VERDICT: [USABLE / PARTIALLY USABLE / NOT USABLE]
NOTES: [specific limitations found]
```

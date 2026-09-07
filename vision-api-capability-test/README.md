# Vision API Capability Test Suite

## Purpose
This test suite determines whether a vision API is usable for **visual UI typography/icon measurement**. It is designed to be run by any LLM with access to vision tools.

## Folder Structure
```
vision-api-capability-test/
  TEST_PROMPT.md          - This file (the test prompt)
  TEST_RESULTS_TEMPLATE.md - Fill this in with results
  run_test.md             - The executable test script
  test-images/            - Input images
  expected-outputs/       - Expected output examples
  results/                - Test results go here
```

## How to Use
1. Copy this folder to your project
2. Open `run_test.md` in your LLM
3. Follow the instructions step by step
4. Record results in `TEST_RESULTS_TEMPLATE.md`
5. Check the verdict at the end

## Test Images
- `home-before.jpg` - Home screen BEFORE recalibration
- `home-after.png` - Home screen AFTER recalibration
- `skills-before.jpg` - Skills Map BEFORE recalibration
- `skills-after.png` - Skills Map AFTER recalibration
- `board-five-phones.png` - Design board with 5 phone mockups
- `board-home-crop.png` - Cropped Home phone from board

## Tests Overview
1. Element Detection Reliability
2. Text Role Grounding Precision
3. Cross-Image Consistency
4. Board Phone Detection
5. Viewport Crop Extraction
6. Pixel Diff Localization
7. Icon Detection
8. Determinism Check

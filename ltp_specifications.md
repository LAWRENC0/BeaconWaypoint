# Beacon Finder ‚Äî Local Test Product (LTP) Specification
**Version:** 1.0-LTP (Pure Client)
**Status:** Ready for Local Prototyping
**Architecture:** 100% Client-Side (No Backend)
**Environment:** Android / Chrome / Landscape-Only

---

## 1. Overview
The **Beacon Finder LTP** is a zero-cost, browser-based tool designed for rapid testing of geospatial camera overlays. The application runs entirely in the user's mobile browser, utilizing client-side JavaScript for all coordinate translations and sensor processing.

**Key Testing Goal:** To verify the accuracy of the "Flat-Plane" mapping model and the effectiveness of manual "Nudge" sliders in correcting smartphone sensor drift.

---

## 2. System Architecture (Pure Client)
Everything happens within the Browser (Chrome on Android):
1.  **UI Layer:** HTML5 / CSS3 (Tailwind or Bootstrap for speed).
2.  **Logic Layer:** Vanilla JavaScript (ES6+).
3.  **Sensor Access:** `DeviceOrientationEvent` and `Geolocation API`.
4.  **External Data:** Direct fetch from Open-Source (Free) APIs.

---

## 3. The "Zero-Cost" Data Flow

| Step | Action | Technology / Provider |
| :--- | :--- | :--- |
| **Search** | Resolve Target Name to Lat/Lon | **Nominatim (OpenStreetMap)** (Free API) |
| **Altitude** | Fetch $h_t$ and $h_u$ | **Open-Elevation API** (Public/Free) |
| **Declination** | Magnetic to True North | **mag-declination.js** (Local Library) |
| **Computation** | Calculate Pixel $X, Y$ | **Local JS Geometry Engine** |

---

## 4. Technical Specifications

### 4.1 Sensor Sampling
To avoid "jitter," sensors are **not** tracked live. 
- The system listens to the `deviceorientationabsolute` stream.
- When "Capture" is pressed, the *last known* Heading ($ lpha$) and Pitch ($ eta$) are frozen into a local variable.

### 4.2 Pixel Mapping Logic (The Geometry Engine)
The following constants are hardcoded for the test device:
- **H-FOV:** $70^\circ$
- **V-FOV:** Calculated via `(Window.innerHeight / Window.innerWidth) * 70`
- **$PPD_H$:** `Window.innerWidth / 70`

**Transformation Math:**
1.  **Distance ($d$):** Haversine formula (JS implementation).
2.  **Bearing ($	heta$):** Forward azimuth formula.
3.  **Elevation ($\phi$):** $ rctan((h_t - h_u) / d)$.
4.  **$X_{pos} = (Width / 2) + ((	heta -  lpha) 	imes PPD_H)$**
5.  **$Y_{pos} = (Height / 2) - (\phi 	imes PPD_V)$**

---

## 5. Local Test Product Features

### 5.1 Clean Viewfinder
- A `<video id="viewfinder">` element covers the background.
- A single `Capture` button (absolute positioned at the bottom).

### 5.2 The Result Overlay
- Upon capture, the `<video>` is paused or a frame is drawn to a `<canvas>`.
- An SVG `<circle>` (Red Dot) is rendered at `X_pos, Y_pos`.
- A text label displays the distance and the name of the target.

### 5.3 Manual Nudge Sliders (Calibration)
Since this is a test product, two range sliders are provided on the result screen:
- **Horizontal Offset:** Translates the dot $\pm 100$ pixels.
- **Vertical Offset:** Translates the dot $\pm 100$ pixels.
*Note: These offsets help the tester identify if the error is consistent (indicating a sensor bias) or random.*

---

## 6. Constraints & Safety Gates
1.  **Hard Distance Limit:** $70,000m$ (70km).
2.  **Orientation Lock:** The UI will display a "Please Rotate to Landscape" message if the aspect ratio is not wider than it is tall.
3.  **Local Storage:** To save on API calls, targets are saved in `localStorage` once resolved.

---

## 7. Setup & Execution
1.  **Local Server:** Use `python -m http.server` or VS Code "Live Server."
2.  **HTTPS Requirement:** Chrome requires a Secure Context (HTTPS or `localhost`) to access Camera and Sensors.
    - *For mobile testing:* Use **ngrok** to tunnel your local port to an HTTPS URL.

---

## 8. Out of Scope for LTP
- Data persistence (No database).
- User accounts.
- Performance optimization for low-end devices.
- Atmospheric refraction/Earth curvature.
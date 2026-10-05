// Theme configuration for Mappedin SDK
const theme = {
  "name": "personal",
  "showEntrances": false,
  "isDark": false,
  "wallHeights": {
    "interior": 1,
    "exterior": 1.1
  },
  "roomHeights": {
    "standard": 0.1,
    "hallway": 0.1,
    "bathroom": 0.1,
    "inaccessible": 0.1
  },
  "objectHeight": 0.5,
  "colors": {
    "accent": {
      "primary": "#881814",
      "secondary": "#BFBFBF",
      "neutral": "#D9D9D9",
      "neutral2": "#D9D9D9",
      "success": "#389E0D",
      "error": "#D46B08"
    },
    "background": {
      "primary": "#FFFFFF",
      "secondary": "#F5F5F5",
      "tertiary": "#E6F4FB",
      "inverted": "#000000"
    },
    "text": {
      "primary": "#54595F",
      "secondary": "#881814",
      "tertiary": "#8C8C8C",
      "quaternary": "#881814",
      "highlight": "#881814",
      "placeholder": "#BFBFBF",
      "inverted": "#FFFFFF",
      "error": "#D46B08",
      "link": "#881814"
    },
    "map": {
      "labels": {
        "default": "#881814",
        "defaultOutline": "#FFFFFF",
        "connection": "#128387",
        "connectionOutline": "#FFFFFF",
        "washroom": "#3161B4",
        "washroomOutline": "#FFFFFF",
        "parking": "#418425",
        "parkingOutline": "#FFFFFF",
        "point": "#AD468F",
        "pointOutline": "#FFFFFF",
        "door": "#881814",
        "doorOutline": "#FFFFFF"
      },
      "markers": {
        "text": "auto",
        "icon": "#FFFFFF",
        "background": "#FFFFFF",
        "default": "#54595F",
        "parachute": "#D46B08",
        "highlight": "#EF8B38",
        "departure": "#881814",
        "destination": "#881814",
        "youAreHere": "#CF1322"
      },
      "geometry": {
        "wallTops": "#881814",
        "departure": "#881814",
        "highlight": "#EF8B38",
        "hover": "#D27A31"
      },
      "path": "#881814",
      "background": "#CFCFCF"
    },
    "rooms": {
      "standard": "#f5f5f5",
      "inaccessible": "#F3F0E7",
      "bathroom": "#E6F4FB",
      "hallway": "#FFFFFF",
      "connection": "#f5f5f5",
      "wall": "#FFFFFF",
      "desk": "#C9C7C2",
      "exteriorWall": "#FFFFFF",
      "doors": "#881814"
    }
  },
  "font": "Onest",
  "fontSize": {
    "xsmall": 12,
    "small": 14,
    "normal": 16,
    "large": 18,
    "xlarge": 20
  },
  "borderRadius": {
    "primary": 4,
    "large": 8,
    "small": 2
  },
  "fontWeight": {
    "light": 300,
    "normal": 400,
    "medium": 500,
    "semiBold": 600,
    "bold": 700
  },
  "outdoorStyle": "outdoor-style-1773826412649.json"
};

export default theme;
export const colors = theme.colors;

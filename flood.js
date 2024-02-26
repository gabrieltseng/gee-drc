var fao_country_dataset = ee.FeatureCollection('FAO/GAUL/2015/level0');
var somalia_feature = fao_country_dataset.filter(ee.Filter.eq("ADM0_NAME", "Somalia"))
var aoi = somalia_feature.first().geometry();
Map.centerObject(aoi)
Map.setOptions('Satellite')
var start_date = '2017-03-28' // start date of L2A imagery

var waterPalette = ['white', 'blue']


function maskS2clouds(image) {
  var qa = image.select('QA60');

  // Bits 10 and 11 are clouds and cirrus, respectively.
  var cloudBitMask = 1 << 10;
  var cirrusBitMask = 1 << 11;

  // Both flags should be set to zero, indicating clear conditions.
  var mask = qa.bitwiseAnd(cloudBitMask).eq(0)
      .and(qa.bitwiseAnd(cirrusBitMask).eq(0));

  return image.updateMask(mask).divide(10000);
}

function getSentinel(start_date, end_date) {
  return ee.ImageCollection('COPERNICUS/S2_SR')
                  .filterDate(start_date, end_date)
                  // Pre-filter to get less cloudy granules.
                  .filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE',20))
                  .map(maskS2clouds);
}

function ndwiFromSentinel(start_date, end_date){
  var sentinel = getSentinel(start_date, end_date);
  return sentinel.map(function(image) {
    // https://custom-scripts.sentinel-hub.com/custom-scripts/sentinel-2/ndwi/
    return image.normalizedDifference(['B3', 'B8'])
  }).mean()
}

// Generate main panel and add it to the map.
var panel = ui.Panel({style: {width:'33.333%'}});
ui.root.insert(0,panel);

// Define title and description.
var intro = ui.Label('Water presence using NDWI',
  {fontWeight: 'bold', fontSize: '24px', margin: '10px 5px'}
);
var subtitle = ui.Label('Use 10 m Sentinel 2 imagery to'+
  ' visualize water presence, and compare it to historical water presence', {});

// Add title and description to the panel
panel.add(intro).add(subtitle);

var durpanel = ui.Label({
  value:'1. Select Year for NDWI map',
  style:{fontSize: '16px', fontWeight: 'bold'}});

var selectYr = ui.Textbox({placeholder: 'Year',  value: '2023',
  style: {width: '100px'}});

var datasetRange_label = ui.Label('Choose year from 2017 - Now      ',
  {margin: '0 0 0 10px',fontSize: '12px',color: 'gray'});

panel.add(durpanel)
  .add(datasetRange_label)
  .add(selectYr);

var monthpanel = ui.Label({
  value:'2. Select Month for NDWI map',
  style:{fontSize: '16px', fontWeight: 'bold'}});

var selectMnth = ui.Select(
  {items: [{label: 'January', value: 0},
          {label: 'February', value: 1},
          {label: 'March', value: 2},
          {label: 'April', value: 3},
          {label: 'May', value: 4},
          {label: 'June', value: 5},
          {label: 'July', value: 6},
          {label: 'August', value: 7},
          {label: 'September', value: 8},
          {label: 'October', value: 9},
          {label: 'November', value: 10},
          {label: 'December', value: 11},],
  style: {width: '100px'}});

var monthRange_label = ui.Label('Choose month   ',
  {margin: '0 0 0 10px',fontSize: '12px',color: 'gray'});

panel.add(monthpanel)
  .add(monthRange_label)
  .add(selectMnth);

var year = selectYr.getValue()
var month = selectMnth.getValue()

function historicalNDWI() {
  var historical_cutoff_date = new Date(year, month, 1)
  historical_cutoff_date.setHours(-1) // make the cutoff date the last date of the previous month
  var historical_ndwi = ndwiFromSentinel(start_date, historical_cutoff_date)
  var water_mask = historical_ndwi.gte(0)
  Map.addLayer(historical_ndwi.updateMask(water_mask).clip(aoi), {min:-0.25, max:0.25, palette: waterPalette}, "Historical")
}

function currentNDWI() {
  year = selectYr.getValue()
  month = selectMnth.getValue()
  var cutoff_date = new Date(year, month, 1)
  var end_date = new Date(year, month, 1)
  end_date.setMonth(end_date.getMonth() + 1, 1);
  var current_ndwi = ndwiFromSentinel(cutoff_date, end_date)
  var water_mask = current_ndwi.gte(0)
  Map.addLayer(
    current_ndwi.updateMask(water_mask).clip(aoi), {min:0, max:0.25, palette: waterPalette},
    "NDWI for " + year.toString() + " in month " + (month + 1).toString()
    )
}

// Create two buttons that will add the greener or lessGreen images to the map
var mappanel = ui.Label({
  value:'3. Generate an NDWI map',
  style:{fontSize: '16px', fontWeight: 'bold'}});

var map_label = ui.Label('Click the button below to generate a map for the year and month selected in steps 1 and 2. Once a map is generated, you can change the month and year values and generate new maps to compare them',
  {margin: '0 0 0 10px',fontSize: '12px',color: 'gray'});

var current_map = ui.Button('Generate NDWI map for selected month and year', currentNDWI);
// Add all elements to the panel in the correct order.
panel.add(mappanel).add(map_label).add(current_map);

var historical_map_label = ui.Label('Click the button below to generate a historical NDWI map. This is calculated by averaging NDWI for all months prior to the month and year selected in steps 1 and 2. Since this requires pulling all historical data, this can be quite slow',
  {margin: '0 0 0 10px',fontSize: '12px',color: 'gray'});
var historical_map = ui.Button('Generate historical NDWI map', historicalNDWI);

panel.add(historical_map_label).add(historical_map);

var reset_label = ui.Label('The button below removes all generated maps.',
  {margin: '0 0 0 10px',fontSize: '12px',color: 'gray'});
var resetButton = ui.Button('Reset Map', reset);
panel.add(reset_label).add(resetButton);

/*
Reset Map
*/
function reset(){
  Map.clear();
}

Map.setOptions('Satellite')
Map.style().set('cursor', 'crosshair');
// this is just because filterDate forces us to set a start date and end date
var start_date = '1970-01-01';

var dataset = ee.FeatureCollection('FAO/GAUL/2015/level0');
var somalia_feature = dataset.filter(ee.Filter.eq("ADM0_NAME", "Somalia"))
var aoi = somalia_feature.first().geometry();
Map.centerObject(aoi);

// computes the foward difference of an array image.
var forwardDifference = function(image) {
  var left = image.arraySlice(0, 0, -1)
  var right = image.arraySlice(0, 1)
  return left.subtract(right)
}

function calculateRunLength(poi_monthly_mean, long_term_monthly_mean, anomaly_is_above_mean) {
  // max run lengths for the current POI
  // https://medium.com/google-earth/runs-with-arrays-400de937510a
  var axis = 0;
  var maxSize = long_term_monthly_mean.size()
  var indexes = ee.Image.constant(ee.Array(ee.List.sequence(0, maxSize)));
  var cur_poi_month_mean = poi_monthly_mean.toArray()
  var array_length = long_term_monthly_mean.toArray().arrayLength(0).toArray()
  cur_poi_month_mean = cur_poi_month_mean.arrayReshape(array_length, 1).arrayPad([maxSize], 0)
  long_term_monthly_mean = long_term_monthly_mean.toArray()
  long_term_monthly_mean = long_term_monthly_mean.arrayReshape(array_length, 1)
  var cur_poi_run_diff = cur_poi_month_mean.subtract(long_term_monthly_mean);
  indexes = indexes.arraySlice(axis, 0, cur_poi_run_diff.arrayLength(0));
  if (anomaly_is_above_mean) {
    var thresh = cur_poi_run_diff.gt(0)
  }
  else {
    thresh = cur_poi_run_diff.lt(0)
  }
  cur_poi_run_diff = cur_poi_run_diff.multiply(thresh)
  var difference = forwardDifference(cur_poi_run_diff);
  var ones = ee.Image(ee.Array([1]))
  difference = ones.addBands(difference).toArray(0);
  var runStarts = indexes.arrayMask(difference.neq(0))
  var runLengths = runStarts.addBands(long_term_monthly_mean.arrayLengths()).toArray(0)
  runLengths = forwardDifference(runLengths.multiply(-1))
  var maxIndex = runLengths.arrayArgmax().arrayGet(0)
  var maxRunLengths = runLengths.arrayGet(maxIndex).unmask(0)
  return maxRunLengths
}

function calculateIndex(dataset, start_month, end_month, cutoff_date,end_date,band_name,anomaly_is_above_mean) {
  if (end_month > start_month) {
    var months = ee.List.sequence(start_month, end_month);
  }
  else {
    months = ee.List.sequence(start_month, 12).cat(ee.List.sequence(1, end_month))
  }
  var years = ee.List.sequence(1970, cutoff_date.get('year'))

  // isolate only the months in the poi (period of interest)
  var poi = dataset.filter(ee.Filter.calendarRange(start_month, end_month,'month'));
  // split into previous POIs and the current POI
  var previous_pois = poi.filterDate(start_date,cutoff_date).select(band_name);
  var previous_pois_mean = previous_pois.mean()
  // for the current POI, take a monthly mean and and overall mean
  var cur_poi = poi.filterDate(cutoff_date,end_date).select(band_name)
  var cur_poi_month_mean = ee.ImageCollection.fromImages(
    months.map(function (m) {
    return cur_poi.filter(ee.Filter.calendarRange(m, m, 'month'))
                .mean()
                .set('month', m).unmask(0);
     }));
  var cur_poi_meaned = cur_poi.mean()

  var long_term_monthly_mean = ee.ImageCollection.fromImages(
    months.map(function (m) {
    return poi.filter(ee.Filter.calendarRange(m, m, 'month'))
                .mean()
                .set('month', m).unmask(0);
     }));
  var runlengths = calculateRunLength(cur_poi_month_mean, long_term_monthly_mean, anomaly_is_above_mean)
  var previous_years = previous_pois
    .map(function(image) {
      return ee.Feature(null, {'year': ee.Number.parse(image.date().format('YYYY'))})
    })
    .distinct('year')
    .aggregate_array('year')
  var ltm_runlengths = ee.ImageCollection.fromImages(
    previous_years.slice(1, -1).map(function(y) {
      y = ee.Number(y);
      var start_year = ee.Number(y);
      if (end_month < start_month) {
        start_year = start_year.subtract(1);
      }
      var start_date = ee.Date.fromYMD(start_year, start_month - 1, 28);
      var end_date = ee.Date.fromYMD(y, end_month + 1, 28);
      var cur_period = previous_pois.filterDate(start_date, end_date);
      var cur_poi_month_mean = ee.ImageCollection.fromImages(
        months.map(function (m) {
        return cur_period.filter(ee.Filter.calendarRange(m, m, 'month'))
                    .mean()
                    // this unmask feels hackey. I don't know if it will
                    // cause problems in the CDI calculations
                    .set('month', m).unmask(0);
        }));
      return calculateRunLength(cur_poi_month_mean, long_term_monthly_mean, anomaly_is_above_mean);
    })).mean();
  var index = (cur_poi_meaned.divide(previous_pois_mean)).multiply((runlengths.divide(ltm_runlengths)).sqrt())
  return index
}

var threshold_index = function(image){
  var image02 = image.gte(0.4);
  var image04 = image.gte(0.6);
  var image06 = image.gte(0.8);
  var image08 = image.gte(1.0);
  return image02.add(image04).add(image06).add(image08);
};

function getMap(month,year,number_of_months_to_lookback,aoi) {

  var start_month = month - (number_of_months_to_lookback - 1)
  var start_year = year
  if (start_month <= 0) {
    start_month += 12;
    start_year -= 1
  }
  var cutoff_date = ee.Date(new Date(start_year, start_month - 1, 0))
  var end_date = ee.Date(new Date(year, month, 0))
  var lst_modis = ee.ImageCollection('MODIS/061/MOD11A2').filterBounds(aoi).select('LST_Day_1km')
  var pst_chirps = ee.ImageCollection('UCSB-CHG/CHIRPS/PENTAD').filterBounds(aoi).select('precipitation')
  var resample = function (image){
    return image.resample('bilinear').reproject({
      crs: pst_chirps.first().projection().crs(),
      scale: 1000
  })}
  lst_modis = lst_modis.map(resample)
  pst_chirps = pst_chirps.map(resample)
  var lst_index = calculateIndex(lst_modis,start_month,month,cutoff_date,end_date,'LST_Day_1km',true)
  var pst_index = calculateIndex(pst_chirps,start_month,month,cutoff_date,end_date,'precipitation',false)
  var index = lst_index.expression('(0.5 * lst) + (0.5 * pst)', {'lst': lst_index, 'pst': pst_index})
  return threshold_index(index)
}

// Generate main panel and add it to the map.
var panel = ui.Panel({style: {width:'33.333%'}});
ui.root.insert(0,panel);

// Define title and description.
var intro = ui.Label('Combined Drought Index using Temperature and Precipitation',
  {fontWeight: 'bold', fontSize: '24px', margin: '10px 5px'}
);
var subtitle = ui.Label('Following the approach described in '+
  'https://cdi.faoswalim.org/index/cdi', {});

// Add title and description to the panel
panel.add(intro).add(subtitle);

var durpanel = ui.Label({
  value:'1. Select Year for CDI map',
  style:{fontSize: '18px', fontWeight: 'bold'}});

var selectYr = ui.Textbox({placeholder: 'Year',  value: '2023',
  style: {width: '100px'}});

var datasetRange_label = ui.Label('Choose year from 2017 - Now      ',
  {margin: '0 0 0 10px',fontSize: '12px',color: 'gray'});

panel.add(durpanel)
  .add(datasetRange_label)
  .add(selectYr);

var monthpanel = ui.Label({
  value:'2. Select Month for CDI map',
  style:{fontSize: '18px', fontWeight: 'bold'}});

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

var moipanel = ui.Label({
  value:'3. Select number of months to consider in period of interest for CDI map',
  style:{fontSize: '18px', fontWeight: 'bold'}});

var selectMOI = ui.Textbox({placeholder: 'Months of interest',  value: '6',
  style: {width: '100px'}});

var MOIRange_label = ui.Label('Choose how many months to lookback (recommended 3 - 18)   ',
  {margin: '0 0 0 10px',fontSize: '12px',color: 'gray'});

panel.add(moipanel)
  .add(MOIRange_label)
  .add(selectMOI);

var year = selectYr.getValue()
var month = selectMnth.getValue()
var moi = selectMOI.getValue()


function CDIMap() {
  year = selectYr.getValue()
  month = selectMnth.getValue()
  moi = selectMOI.getValue()
  var map = getMap(1,2022,6,aoi);
  Map.addLayer(map.clip(aoi),
    {min: 0, max: 4, palette: ['brown','red', 'orange', 'yellow', 'green']},
    "CDI for " + year.toString() + " in month " + (month + 1).toString() + " looking back " + moi.toString() + " months"
  )
}

var mappanel = ui.Label({
  value:'4. Generate a CDI map',
  style:{fontSize: '16px', fontWeight: 'bold'}});

var map_label = ui.Label('Click the button below to generate a map for the year, month and lookback period selected in steps 1, 2 and 3. Once a map is generated, you can change the month, year and lookback values and generate new maps to compare them',
  {margin: '0 0 0 10px',fontSize: '12px',color: 'gray'});
var current_map = ui.Button('Generate CDI map for selected month and year', CDIMap);
// Add all elements to the panel in the correct order.
panel.add(mappanel).add(map_label).add(current_map);

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

var color = ['brown','red', 'orange', 'yellow', 'green']
var lc_class = ['Extreme drought', 'Severe drought', 'Moderate drought','Light drought', 'No drought']
var list_legend = function(color, description) {

  var c = ui.Label({
    style: {
      backgroundColor: color,
      padding: '10px',
      margin: '5px'
    }
  })

  var ds = ui.Label({
    value: description,
    style: {
      margin: '5px'
    }
  })

  return ui.Panel({
    widgets: [c, ds],
    layout: ui.Panel.Layout.Flow('horizontal')
  })
}

var cbarpanel = ui.Label({
  value:'Map legend',
  style:{fontSize: '16px', fontWeight: 'bold'}});

var cbarlabel = ui.Label('The colorbar and corresponding drought severities are plotted below',
  {margin: '0 0 0 10px',fontSize: '12px',color: 'gray'});

panel.add(cbarpanel).add(cbarlabel)
for(var a = 0; a < 5; a++){
  panel.add(list_legend(color[a], lc_class[a]))
}

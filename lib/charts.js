const chartAnnotations = require('chartjs-plugin-annotation');
const chartBoxViolinPlot = require('chartjs-chart-box-and-violin-plot');
const chartDataLabels = require('chartjs-plugin-datalabels');
const chartRadialGauge = require('chartjs-chart-radial-gauge');
const deepmerge = require('deepmerge');
const pattern = require('patternomaly');
const { CanvasRenderService } = require('chartjs-node-canvas');
const { createCanvas } = require('canvas');
const { NodeVM } = require('vm2');

const { fixNodeVmObject } = require('./util');
const { logger } = require('../logging');

const ROUND_CHART_TYPES = new Set([
  'pie',
  'doughnut',
  'polarArea',
  'outlabeledPie',
  'outlabeledDoughnut',
]);

const BOXPLOT_CHART_TYPES = new Set(['boxplot', 'horizontalBoxplot', 'violin', 'horizontalViolin']);

const MAX_HEIGHT = process.env.CHART_MAX_HEIGHT || 3000;
const MAX_WIDTH = process.env.CHART_MAX_WIDTH || 3000;

const rendererCache = {};

function getRenderer(width, height) {
  if (width > MAX_WIDTH) {
    throw `Requested width exceeds maximum of ${MAX_WIDTH}`;
  }
  if (height > MAX_HEIGHT) {
    throw `Requested width exceeds maximum of ${MAX_WIDTH}`;
  }

  const key = [width, height];
  if (!rendererCache[key]) {
    rendererCache[key] = new CanvasRenderService(width, height);
  }
  return rendererCache[key];
}

function addColorsPlugin(chart) {
  if (chart.options && chart.options.plugins && chart.options.plugins.colorschemes) {
    return;
  }

  chart.options = deepmerge.all([
    {},
    chart.options,
    {
      plugins: {
        colorschemes: {
          scheme: 'tableau.Tableau10',
        },
      },
    },
  ]);
}

function getGradientFunctions(width, height) {
  let temporaryCanvas = undefined;

  const getGradientFill = (colorOptions, linearGradient = [0, 0, width, 0]) => {
    if (!temporaryCanvas) {
      temporaryCanvas = createCanvas(20, 20);
    }
    const ctx = temporaryCanvas.getContext('2d');
    const gradientFill = ctx.createLinearGradient(...linearGradient);
    colorOptions.forEach((options, idx) => {
      gradientFill.addColorStop(options.offset, options.color);
    });
    return gradientFill;
  };

  const getGradientFillHelper = (direction, colors, dimensions = {}) => {
    const colorOptions = colors.map((color, idx) => {
      return {
        color,
        offset: idx / (colors.length - 1 || 1),
      };
    });

    let linearGradient = [0, 0, dimensions.width || width, 0];
    if (direction === 'vertical') {
      linearGradient = [0, 0, 0, dimensions.height || height];
    } else if (direction === 'both') {
      linearGradient = [0, 0, dimensions.width || width, dimensions.height || height];
    }
    return getGradientFill(colorOptions, linearGradient);
  };

  return {
    getGradientFill,
    getGradientFillHelper,
  };
}

function patternDraw(shapeType, backgroundColor, patternColor, requestedSize) {
  const size = Math.min(200, requestedSize) || 20;
  // patternomaly requires a document global...
  global.document = {
    createElement: () => {
      return createCanvas(size, size);
    },
  };
  return pattern.draw(shapeType, backgroundColor, patternColor, size);
}

function renderChartJs(width, height, backgroundColor, devicePixelRatio, untrustedChart) {
  let chart;
  if (typeof untrustedChart === 'string') {
    // The chart could contain Javascript - run it in a VM.
    try {
      const { getGradientFill, getGradientFillHelper } = getGradientFunctions(width, height);
      const vm = new NodeVM({
        console: 'off',
        eval: false,
        wasm: false,
        sandbox: {
          getGradientFill,
          getGradientFillHelper,
          pattern: {
            draw: patternDraw,
          },
          Chart: require('chart.js'),
        },
      });
      chart = vm.run(`module.exports = ${untrustedChart}`);
    } catch (err) {
      logger.error('Input Error', err, untrustedChart);
      return Promise.reject(new Error(`Invalid input\n${err}`));
    }
  } else {
    // The chart is just a simple JSON object, nothing to be afraid of.
    chart = untrustedChart;
  }

  // Patch some bugs and issues.
  fixNodeVmObject(chart);
  if (global.CanvasGradient === undefined) {
    // See https://github.com/vmpowerio/chartjs-node/issues/26
    global.CanvasGradient = function() {};
  }

  chart.options = chart.options || {};

  if (chart.type === 'donut') {
    // Fix spelling...
    chart.type = 'doughnut';
  }

  // TODO(ian): Move special chart type out of this file.
  if (chart.type === 'sparkline') {
    if (chart.data.datasets.length < 1) {
      return Promise.reject(new Error('"sparkline" requres 1 dataset'));
    }
    chart.type = 'line';
    const dataseries = chart.data.datasets[0].data;
    if (!chart.data.labels) {
      chart.data.labels = Array(dataseries.length);
    }
    chart.options.legend = chart.options.legend || {
      display: false,
    };
    if (!chart.options.elements) {
      chart.options.elements = {};
    }
    chart.options.elements.line = chart.options.elements.line || {
      borderColor: '#000',
      borderWidth: 1,
    };
    chart.options.elements.point = chart.options.elements.point || {
      radius: 0,
    };
    if (!chart.options.scales) {
      chart.options.scales = {};
    }

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < dataseries.length; i += 1) {
      const dp = dataseries[i];
      min = Math.min(min, dp);
      max = Math.max(max, dp);
    }

    chart.options.scales.xAxes = chart.options.scales.xAxes || [
      {
        display: false,
      },
    ];
    chart.options.scales.yAxes = chart.options.scales.yAxes || [
      {
        display: false,
        ticks: {
          // Offset the min and max slightly so that pixels aren't shaved off
          // under certain circumstances.
          min: min - min * 0.05,
          max: max + max * 0.05,
        },
      },
    ];
  }

  // Choose retina resolution by default. This will cause images to be 2x size
  // in absolute terms.
  chart.options.devicePixelRatio = devicePixelRatio || 2.0;

  // Implement other default options
  if (
    chart.type === 'bar' ||
    chart.type === 'horizontalBar' ||
    chart.type === 'line' ||
    chart.type === 'scatter' ||
    chart.type === 'bubble'
  ) {
    if (!chart.options.scales) {
      // TODO(ian): Merge default options with provided options
      chart.options.scales = {
        yAxes: [
          {
            ticks: {
              beginAtZero: true,
            },
          },
        ],
      };
    }
    addColorsPlugin(chart);
  } else if (chart.type === 'radar') {
    addColorsPlugin(chart);
  } else if (ROUND_CHART_TYPES.has(chart.type)) {
    addColorsPlugin(chart);
  } else if (chart.type === 'scatter') {
    addColorsPlugin(chart);
  } else if (chart.type === 'bubble') {
    addColorsPlugin(chart);
  }

  if (chart.type === 'line') {
    if (chart.data && chart.data.datasets) {
      chart.data.datasets.forEach(dataset => {
        const data = dataset;
        // Make line charts straight lines by default.
        data.lineTension = data.lineTension || 0;
      });
    }
  }

  chart.options.plugins = chart.options.plugins || {};
  let usingDataLabelsDefaults = false;
  if (!chart.options.plugins.datalabels) {
    usingDataLabelsDefaults = true;
    chart.options.plugins.datalabels = {};
    if (chart.type === 'pie' || chart.type === 'doughnut') {
      chart.options.plugins.datalabels = {
        display: true,
      };
    } else {
      chart.options.plugins.datalabels = {
        display: false,
      };
    }
  }

  // Enable treemap
  if (chart.type === 'treemap') {
    global.Chart = require('chart.js');
    require('chartjs-chart-treemap');
  }

  if (ROUND_CHART_TYPES.has(chart.type) || chart.type === 'radialGauge') {
    global.Chart = require('chart.js');
    // These requires have side effects.
    require('chartjs-plugin-piechart-outlabels');
    if (chart.type === 'doughnut' || chart.type === 'outlabeledDoughnut') {
      require('chartjs-plugin-doughnutlabel');
    }
    let userSpecifiedOutlabels = false;
    chart.data.datasets.forEach(dataset => {
      if (dataset.outlabels || chart.options.plugins.outlabels) {
        userSpecifiedOutlabels = true;
      } else {
        // Disable outlabels by default.
        dataset.outlabels = {
          display: false,
        };
      }
    });

    if (userSpecifiedOutlabels && usingDataLabelsDefaults) {
      // If outlabels are enabled, disable datalabels by default.
      chart.options.plugins.datalabels = {
        display: false,
      };
    }
  }
  if (chart.options && chart.options.plugins && chart.options.plugins.colorschemes) {
    global.Chart = require('chart.js');
    require('chartjs-plugin-colorschemes');
  }
  logger.debug('Chart:', JSON.stringify(chart));

  if (!chart.plugins) {
    chart.plugins = [chartDataLabels, chartAnnotations];
    if (chart.type === 'radialGauge') {
      chart.plugins.push(chartRadialGauge);
    }
    if (BOXPLOT_CHART_TYPES.has(chart.type)) {
      chart.plugins.push(chartBoxViolinPlot);
    }
  }

  // Background color plugin
  chart.plugins.push({
    id: 'background',
    beforeDraw: chartInstance => {
      if (backgroundColor) {
        const { chart } = chartInstance;
        const { ctx } = chart;
        ctx.fillStyle = backgroundColor;
        ctx.fillRect(0, 0, chart.width, chart.height);
      }
    },
  });

  // Pad below legend plugin
  if (chart.options.plugins.padBelowLegend) {
    chart.plugins.push({
      id: 'padBelowLegend',
      beforeInit: (chartInstance, val) => {
        global.Chart.Legend.prototype.afterFit = function() {
          this.height = this.height + (Number(val) || 0);
        };
      },
    });
  }

  const canvasRenderService = getRenderer(width, height);

  try {
    return canvasRenderService.renderToBuffer(chart);
  } catch (err) {
    // canvasRenderService doesn't seem to be throwing errors correctly for
    // certain chart errors.
    return Promise.reject(err.message || err);
  }
}

module.exports = {
  renderChartJs,
};

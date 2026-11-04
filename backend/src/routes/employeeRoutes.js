'use strict';

const express = require('express');
const asyncHandler = require('../middleware/asyncHandler');
const controller = require('../controllers/employeeController');

const router = express.Router();

router.get('/', asyncHandler(controller.list));
router.get('/export', asyncHandler(controller.exportCsv));
router.get('/:id', asyncHandler(controller.getById));
router.post('/', asyncHandler(controller.create));
router.put('/:id', asyncHandler(controller.update));
router.delete('/:id', asyncHandler(controller.remove));

module.exports = router;

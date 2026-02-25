const paginate = async (model, filter = {}, options = {}) => {
    const page = parseInt(options.page) || 1;
    const limit = Math.min(parseInt(options.limit) || 10, 50);
    const skip = (page - 1) * limit;

    const total = await model.countDocuments(filter);

    const data = await model.find(filter)
        .sort(options.sort || { createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .select(options.select || "");

    return {
        data,
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasNext: page * limit < total,
            hasPrev: page > 1,
        },
    };
};

module.exports = paginate;